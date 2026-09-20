// worker/src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, ClientSettings } from './types';
import {
  getOrCreateClient,
  updateClientSettings,
  getClientRules,
  createClientRule,
  updateClientRule,
  deleteClientRule,
  checkRateLimit,
} from './db/queries';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const app = new Hono<{ Bindings: Env; Variables: { clientId: string } }>();

// Enable CORS for Chrome extensions and web UI
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Client-Id'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
}));

// Client authentication middleware
app.use('/v1/*', async (c, next) => {
  const clientId = c.req.header('X-Client-Id');

  if (!clientId || !UUID_REGEX.test(clientId)) {
    return c.json({ error: 'Missing or invalid X-Client-Id header. Expected a valid UUID.' }, 401);
  }

  c.set('clientId', clientId);
  await next();
});

// Rate limiting middleware for mutation endpoints
app.use('/v1/notifications/*', async (c, next) => {
  const clientId = c.get('clientId');

  // If rate limiting binding is available, use it
  if (c.env.RATE_LIMITER) {
    try {
      const rl = await c.env.RATE_LIMITER.limit({ key: clientId });
      if (!rl.success) {
        return c.json({ error: 'Rate limit exceeded. Maximum 120 notifications per hour.' }, 429);
      }
    } catch {
      // Fall back to database rate limit check
    }
  }

  // Database-backed sliding rate check
  const rlCheck = await checkRateLimit(c.env.DB, clientId, 120);
  c.header('X-RateLimit-Limit', '120');
  c.header('X-RateLimit-Remaining', rlCheck.remaining.toString());

  if (!rlCheck.allowed) {
    return c.json({ error: 'Rate limit exceeded. Maximum 120 notifications per hour.' }, 429);
  }

  await next();
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok', service: 'hush-worker', version: '1.0.0' }));

// -------------------------------------------------------------
// Settings Endpoints
// -------------------------------------------------------------
app.get('/v1/settings', async (c) => {
  const clientId = c.get('clientId');
  const client = await getOrCreateClient(c.env.DB, clientId);
  return c.json(client.settings);
});

app.put('/v1/settings', async (c) => {
  const clientId = c.get('clientId');
  let body: Partial<ClientSettings>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  // Validate threshold ranges if supplied
  if (body.now_threshold !== undefined && (typeof body.now_threshold !== 'number' || body.now_threshold < 0 || body.now_threshold > 1)) {
    return c.json({ error: 'now_threshold must be a number between 0 and 1' }, 400);
  }
  if (body.mute_threshold !== undefined && (typeof body.mute_threshold !== 'number' || body.mute_threshold < 0 || body.mute_threshold > 1)) {
    return c.json({ error: 'mute_threshold must be a number between 0 and 1' }, 400);
  }
  if (body.retention_days !== undefined && (typeof body.retention_days !== 'number' || body.retention_days < 1)) {
    return c.json({ error: 'retention_days must be a positive integer' }, 400);
  }

  const updated = await updateClientSettings(c.env.DB, clientId, body);
  return c.json(updated);
});

// -------------------------------------------------------------
// Rules Endpoints
// -------------------------------------------------------------
app.get('/v1/rules', async (c) => {
  const clientId = c.get('clientId');
  const rules = await getClientRules(c.env.DB, clientId);
  return c.json(rules);
});

app.post('/v1/rules', async (c) => {
  const clientId = c.get('clientId');
  let body: {
    type?: 'sender' | 'domain' | 'keyword';
    pattern?: string;
    action?: 'now' | 'later' | 'mute';
    priority?: number;
    enabled?: boolean;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  if (!body.type || !['sender', 'domain', 'keyword'].includes(body.type)) {
    return c.json({ error: "Invalid rule type. Must be 'sender', 'domain', or 'keyword'." }, 400);
  }
  if (!body.pattern || typeof body.pattern !== 'string' || body.pattern.trim() === '') {
    return c.json({ error: 'Rule pattern must be a non-empty string.' }, 400);
  }
  if (!body.action || !['now', 'later', 'mute'].includes(body.action)) {
    return c.json({ error: "Invalid rule action. Must be 'now', 'later', or 'mute'." }, 400);
  }

  const rule = await createClientRule(c.env.DB, clientId, {
    type: body.type,
    pattern: body.pattern,
    action: body.action,
    priority: body.priority,
    enabled: body.enabled,
  });

  return c.json(rule, 201);
});

app.put('/v1/rules/:id', async (c) => {
  const clientId = c.get('clientId');
  const ruleId = c.req.param('id');
  let body: Partial<{
    type: 'sender' | 'domain' | 'keyword';
    pattern: string;
    action: 'now' | 'later' | 'mute';
    priority: number;
    enabled: boolean;
  }>;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  if (body.type && !['sender', 'domain', 'keyword'].includes(body.type)) {
    return c.json({ error: "Invalid rule type. Must be 'sender', 'domain', or 'keyword'." }, 400);
  }
  if (body.pattern !== undefined && (typeof body.pattern !== 'string' || body.pattern.trim() === '')) {
    return c.json({ error: 'Rule pattern cannot be empty.' }, 400);
  }
  if (body.action && !['now', 'later', 'mute'].includes(body.action)) {
    return c.json({ error: "Invalid rule action. Must be 'now', 'later', or 'mute'." }, 400);
  }

  const updated = await updateClientRule(c.env.DB, clientId, ruleId, body);
  if (!updated) {
    return c.json({ error: 'Rule not found' }, 404);
  }

  return c.json(updated);
});

app.delete('/v1/rules/:id', async (c) => {
  const clientId = c.get('clientId');
  const ruleId = c.req.param('id');

  const deleted = await deleteClientRule(c.env.DB, clientId, ruleId);
  if (!deleted) {
    return c.json({ error: 'Rule not found' }, 404);
  }

  return c.json({ success: true, id: ruleId });
});

// -------------------------------------------------------------
// Data Wipe Endpoint
// -------------------------------------------------------------
app.delete('/v1/data', async (c) => {
  const clientId = c.get('clientId');

  // Cascading delete deletes rules, notifications, drafts, digests, rate_limits
  await c.env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(clientId).run();
  await c.env.DB.prepare('DELETE FROM rate_limits WHERE client_id = ?').bind(clientId).run();

  return c.json({ success: true, message: 'All client data wiped successfully' });
});

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: err.message || 'Internal Server Error' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Scheduled cron handler (implemented in Phase 3)
  }
};
