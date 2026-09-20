// worker/src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env, ClientSettings, NotificationPayload, NotificationRecord } from './types';
import {
  getOrCreateClient,
  updateClientSettings,
  getClientRules,
  createClientRule,
  updateClientRule,
  deleteClientRule,
  checkRateLimit,
  computeDedupeHash,
  checkDuplicateNotification,
  insertNotificationRecord,
  getNotifications,
  getNotificationById,
  updateNotificationAction,
  resurfaceSnoozedNotifications,
  runRetentionCleanup,
  getClientStats,
} from './db/queries';
import { sanitizePayload, isVerificationCode } from './redaction';
import { classifyWithJev } from './classifiers/jev';
import { classifyHeuristic } from './classifiers/heuristic';
import { routeNotification } from './classifiers/router';
import { generateScenarioNotifications, ScenarioType } from './simulator';

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
// Notification Ingestion Endpoints (Phase 2)
// -------------------------------------------------------------

async function processNotificationIngest(
  c: any,
  clientId: string,
  payload: NotificationPayload,
  clientSettings: any,
  rules: any[]
) {
  if (!payload || !payload.title || typeof payload.title !== 'string') {
    throw new Error("Invalid payload: 'title' is required and must be a string.");
  }
  if (!payload.source || !payload.source.domain || typeof payload.source.domain !== 'string') {
    throw new Error("Invalid payload: 'source.domain' is required and must be a string.");
  }

  const rawTitle = payload.title.slice(0, 200);
  const rawBody = (payload.body || '').slice(0, 1000);
  const domain = payload.source.domain;
  const sender = payload.sender;
  const receivedAt = payload.received_at || new Date().toISOString();

  // PII Redaction
  const shouldRedact = clientSettings.redact !== false;
  const { title: sanitizedTitle, body: sanitizedBody, isOtp } = sanitizePayload(rawTitle, rawBody, shouldRedact);

  // Deduplication check
  const dedupeHash = await computeDedupeHash(clientId, domain, sender, sanitizedTitle, sanitizedBody);
  const duplicate = await checkDuplicateNotification(c.env.DB, clientId, dedupeHash, 300);

  if (duplicate) {
    return {
      id: duplicate.id,
      lane: duplicate.lane,
      reason: `deduplicated:${duplicate.lane_reason}`,
      urgency: duplicate.urgency ?? 3,
      confidence: duplicate.p_now ?? 0.8,
      uncertain: Boolean(duplicate.uncertain),
      suspicious: Boolean(duplicate.suspicious),
      classifier: duplicate.classifier,
      classify_ms: duplicate.classify_ms ?? 0,
      deduplicated: true,
    };
  }

  // Determine focus mode state
  const focusMode = typeof payload.focus_mode === 'boolean' ? payload.focus_mode : clientSettings.focus_mode;

  // Run Classifier
  const jevMode = c.env.JEV_MODE || 'heuristic';
  const jevApiKey = clientSettings.jev_api_key || c.env.JEV_API_KEY;
  const jevEndpoint = clientSettings.jev_endpoint || 'https://api.typesafe.ai/v1/systemone';

  let rawClassification;
  if (jevMode === 'heuristic' || !jevApiKey) {
    rawClassification = classifyHeuristic(
      {
        domain,
        sender,
        title: sanitizedTitle,
        body: sanitizedBody,
        focusMode,
      },
      'heuristic'
    );
  } else {
    rawClassification = await classifyWithJev({
      endpoint: jevEndpoint,
      apiKey: jevApiKey,
      domain,
      sender,
      title: sanitizedTitle,
      body: sanitizedBody,
      userPriorities: clientSettings.priorities_text,
      focusMode,
      localTime: receivedAt,
    });
  }

  // Route Decision through deterministic rules and thresholds
  const decision = routeNotification({
    domain,
    sender,
    title: sanitizedTitle,
    body: sanitizedBody,
    focusMode,
    settings: clientSettings,
    rules,
    rawClassification,
  });

  // Critical privacy rule: verification code body MUST NEVER be stored in the database
  const bodyToStore = isOtp || isVerificationCode(`${sanitizedTitle} ${sanitizedBody}`) ? null : sanitizedBody;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const record: NotificationRecord = {
    id,
    client_id: clientId,
    received_at: receivedAt,
    source_domain: domain,
    sender: sender || null,
    title: sanitizedTitle,
    body: bodyToStore,
    dedupe_hash: dedupeHash,
    classifier: decision.classifier,
    lane: decision.lane,
    lane_reason: decision.lane_reason,
    urgency: decision.urgency,
    p_now: decision.p_now,
    p_later: decision.p_later,
    p_mute: decision.p_mute,
    p_time_sensitive: decision.p_time_sensitive,
    p_needs_reply: decision.p_needs_reply,
    p_from_person: decision.p_from_person,
    p_promotional: decision.p_promotional,
    p_suspicious: decision.p_suspicious,
    answers_json: decision.answers ? JSON.stringify(decision.answers) : null,
    uncertain: decision.uncertain ? 1 : 0,
    suspicious: decision.suspicious ? 1 : 0,
    classify_ms: decision.classify_ms,
    status: 'open',
    snooze_until: null,
    user_lane: null,
    created_at: now,
  };

  await insertNotificationRecord(c.env.DB, record);

  return {
    id,
    lane: decision.lane,
    reason: decision.lane_reason,
    urgency: decision.urgency,
    confidence: decision.confidence,
    uncertain: decision.uncertain,
    suspicious: decision.suspicious,
    classifier: decision.classifier,
    classify_ms: decision.classify_ms,
  };
}

app.post('/v1/notifications', async (c) => {
  const clientId = c.get('clientId');
  let payload: NotificationPayload;

  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const client = await getOrCreateClient(c.env.DB, clientId);
  const rules = await getClientRules(c.env.DB, clientId);

  try {
    const result = await processNotificationIngest(c, clientId, payload, client.settings, rules);
    return c.json(result, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.post('/v1/notifications/batch', async (c) => {
  const clientId = c.get('clientId');
  let body: { notifications: NotificationPayload[] };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  if (!body.notifications || !Array.isArray(body.notifications)) {
    return c.json({ error: "'notifications' must be an array" }, 400);
  }

  if (body.notifications.length > 20) {
    return c.json({ error: 'Maximum batch size is 20 notifications' }, 400);
  }

  const client = await getOrCreateClient(c.env.DB, clientId);
  const rules = await getClientRules(c.env.DB, clientId);

  const results = [];
  for (const item of body.notifications) {
    try {
      const res = await processNotificationIngest(c, clientId, item, client.settings, rules);
      results.push(res);
    } catch (err: any) {
      results.push({ error: err.message });
    }
  }

  return c.json({ results });
});

// -------------------------------------------------------------
// Notification List & Actions (Phase 3)
// -------------------------------------------------------------

app.get('/v1/notifications', async (c) => {
  const clientId = c.get('clientId');
  const lane = c.req.query('lane');
  const status = c.req.query('status');
  const limitStr = c.req.query('limit');
  const before = c.req.query('before');

  const limit = limitStr ? parseInt(limitStr, 10) : 50;

  const result = await getNotifications(c.env.DB, clientId, {
    lane,
    status,
    limit,
    before,
  });

  return c.json(result);
});

app.post('/v1/notifications/:id/action', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  let body: {
    action: 'done' | 'snooze' | 'move' | 'mute_source';
    lane?: 'now' | 'later' | 'mute';
    until?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const existing = await getNotificationById(c.env.DB, clientId, id);
  if (!existing) {
    return c.json({ error: 'Notification not found' }, 404);
  }

  switch (body.action) {
    case 'done': {
      const updated = await updateNotificationAction(c.env.DB, clientId, id, { status: 'done' });
      return c.json({ success: true, notification: updated });
    }

    case 'snooze': {
      let until = body.until;
      if (!until) {
        // Default snooze: 1 hour from now
        until = new Date(Date.now() + 3600 * 1000).toISOString();
      }
      const updated = await updateNotificationAction(c.env.DB, clientId, id, {
        status: 'snoozed',
        snooze_until: until,
      });
      return c.json({ success: true, notification: updated });
    }

    case 'move': {
      if (!body.lane || !['now', 'later', 'mute'].includes(body.lane)) {
        return c.json({ error: "Invalid lane. Must be 'now', 'later', or 'mute'." }, 400);
      }
      const updated = await updateNotificationAction(c.env.DB, clientId, id, {
        lane: body.lane,
        user_lane: body.lane, // Record user feedback correction
        lane_reason: `user_moved_to_${body.lane}`,
        status: 'open',
      });
      return c.json({ success: true, notification: updated });
    }

    case 'mute_source': {
      // Create a rule muting this domain
      await createClientRule(c.env.DB, clientId, {
        type: 'domain',
        pattern: existing.source_domain,
        action: 'mute',
        priority: 10,
        enabled: true,
      });

      // Move this notification to mute
      const updated = await updateNotificationAction(c.env.DB, clientId, id, {
        lane: 'mute',
        user_lane: 'mute',
        lane_reason: `muted_source:${existing.source_domain}`,
      });

      return c.json({ success: true, notification: updated, rule_created: existing.source_domain });
    }

    default:
      return c.json({ error: "Invalid action. Supported: 'done', 'snooze', 'move', 'mute_source'" }, 400);
  }
});

// -------------------------------------------------------------
// Stats Endpoint (Phase 3)
// -------------------------------------------------------------
app.get('/v1/stats', async (c) => {
  const clientId = c.get('clientId');
  const windowQuery = c.req.query('window') as '1h' | '24h' | '7d' | undefined;
  const window = windowQuery && ['1h', '24h', '7d'].includes(windowQuery) ? windowQuery : '24h';

  const stats = await getClientStats(c.env.DB, clientId, window);
  return c.json(stats);
});

// -------------------------------------------------------------
// Simulator Endpoint (Phase 3)
// -------------------------------------------------------------
app.post('/v1/simulate', async (c) => {
  const clientId = c.get('clientId');
  let body: { scenario?: ScenarioType; count?: number };
  try {
    body = await c.req.json();
  } catch {
    body = { scenario: 'workday' };
  }

  const scenario = body.scenario || 'workday';
  const count = typeof body.count === 'number' ? Math.min(body.count, 20) : undefined;

  const generated = generateScenarioNotifications(scenario, count);
  const client = await getOrCreateClient(c.env.DB, clientId);
  const rules = await getClientRules(c.env.DB, clientId);

  const ingested = [];
  for (const item of generated) {
    try {
      const res = await processNotificationIngest(c, clientId, item, client.settings, rules);
      ingested.push(res);
    } catch (err: any) {
      ingested.push({ error: err.message });
    }
  }

  return c.json({
    scenario,
    count: ingested.length,
    notifications: ingested,
  });
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
    console.log(`[Cron] Running scheduled maintenance at ${new Date().toISOString()}`);
    // 1. Resurface snoozed notifications whose snooze_until has elapsed
    const resurfaced = await resurfaceSnoozedNotifications(env.DB);
    if (resurfaced > 0) {
      console.log(`[Cron] Resurfaced ${resurfaced} snoozed notifications to 'now'`);
    }

    // 2. Daily retention cleanup
    const retention = await runRetentionCleanup(env.DB);
    if (retention.bodiesNullified > 0 || retention.rowsDeleted > 0) {
      console.log(`[Cron] Retention cleanup: ${retention.bodiesNullified} bodies nullified, ${retention.rowsDeleted} rows deleted`);
    }
  }
};

