// worker/src/db/queries.ts
import { ClientSettings, Rule, NotificationRecord } from '../types';

export const DEFAULT_SETTINGS: ClientSettings = {
  priorities_text: '',
  focus_mode: false,
  focus_schedule: {
    enabled: false,
    start: '09:00',
    end: '17:00',
    days: [1, 2, 3, 4, 5],
  },
  now_threshold: 0.6,
  mute_threshold: 0.8,
  redact: true,
  retention_days: 7,
  allowed_sites: [],
  jev_endpoint: 'https://api.typesafe.ai/v1/systemone',
  llm_base_url: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
  llm_model: '@cf/meta/llama-3.1-8b-instruct',
};

export async function getOrCreateClient(db: D1Database, clientId: string): Promise<{ id: string; settings: ClientSettings }> {
  const now = new Date().toISOString();
  const existing = await db.prepare('SELECT id, settings_json FROM clients WHERE id = ?').bind(clientId).first<{ id: string; settings_json: string }>();

  if (existing) {
    await db.prepare('UPDATE clients SET last_seen_at = ? WHERE id = ?').bind(now, clientId).run();
    try {
      const parsed = JSON.parse(existing.settings_json || '{}');
      return { id: clientId, settings: { ...DEFAULT_SETTINGS, ...parsed } };
    } catch {
      return { id: clientId, settings: DEFAULT_SETTINGS };
    }
  }

  const initialSettingsJson = JSON.stringify(DEFAULT_SETTINGS);
  await db.prepare('INSERT INTO clients (id, created_at, last_seen_at, settings_json) VALUES (?, ?, ?, ?)')
    .bind(clientId, now, now, initialSettingsJson)
    .run();

  return { id: clientId, settings: DEFAULT_SETTINGS };
}

export async function updateClientSettings(db: D1Database, clientId: string, updates: Partial<ClientSettings>): Promise<ClientSettings> {
  const { settings } = await getOrCreateClient(db, clientId);
  const newSettings = { ...settings, ...updates };
  const now = new Date().toISOString();

  await db.prepare('UPDATE clients SET settings_json = ?, last_seen_at = ? WHERE id = ?')
    .bind(JSON.stringify(newSettings), now, clientId)
    .run();

  return newSettings;
}

export async function getClientRules(db: D1Database, clientId: string): Promise<Rule[]> {
  const result = await db.prepare('SELECT * FROM rules WHERE client_id = ? ORDER BY priority DESC, created_at ASC')
    .bind(clientId)
    .all<Rule>();

  return result.results || [];
}

export async function createClientRule(
  db: D1Database,
  clientId: string,
  ruleData: { type: 'sender' | 'domain' | 'keyword'; pattern: string; action: 'now' | 'later' | 'mute'; priority?: number; enabled?: boolean }
): Promise<Rule> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const priority = typeof ruleData.priority === 'number' ? ruleData.priority : 0;
  const enabled = ruleData.enabled === false ? 0 : 1;

  await db.prepare(
    'INSERT INTO rules (id, client_id, type, pattern, action, priority, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, clientId, ruleData.type, ruleData.pattern.trim(), ruleData.action, priority, enabled, now)
    .run();

  return {
    id,
    client_id: clientId,
    type: ruleData.type,
    pattern: ruleData.pattern.trim(),
    action: ruleData.action,
    priority,
    enabled,
    created_at: now,
  };
}

export async function updateClientRule(
  db: D1Database,
  clientId: string,
  ruleId: string,
  updates: Partial<Pick<Rule, 'type' | 'pattern' | 'action' | 'priority' | 'enabled'>>
): Promise<Rule | null> {
  const existing = await db.prepare('SELECT * FROM rules WHERE id = ? AND client_id = ?')
    .bind(ruleId, clientId)
    .first<Rule>();

  if (!existing) return null;

  const type = updates.type ?? existing.type;
  const pattern = updates.pattern !== undefined ? updates.pattern.trim() : existing.pattern;
  const action = updates.action ?? existing.action;
  const priority = updates.priority !== undefined ? updates.priority : existing.priority;
  const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled;

  await db.prepare(
    'UPDATE rules SET type = ?, pattern = ?, action = ?, priority = ?, enabled = ? WHERE id = ? AND client_id = ?'
  )
    .bind(type, pattern, action, priority, enabled, ruleId, clientId)
    .run();

  return {
    ...existing,
    type,
    pattern,
    action,
    priority,
    enabled,
  };
}

export async function deleteClientRule(db: D1Database, clientId: string, ruleId: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM rules WHERE id = ? AND client_id = ?')
    .bind(ruleId, clientId)
    .run();

  return (res.meta?.changes ?? 0) > 0;
}

export async function checkRateLimit(db: D1Database, clientId: string, maxPerHour = 120): Promise<{ allowed: boolean; remaining: number }> {
  // 1-hour window bucket
  const windowSizeMs = 3600 * 1000;
  const now = Date.now();
  const windowStart = Math.floor(now / windowSizeMs) * windowSizeMs;

  const row = await db.prepare(
    'SELECT count FROM rate_limits WHERE client_id = ? AND window_start = ?'
  ).bind(clientId, windowStart).first<{ count: number }>();

  const currentCount = row?.count ?? 0;

  if (currentCount >= maxPerHour) {
    return { allowed: false, remaining: 0 };
  }

  if (!row) {
    await db.prepare(
      'INSERT INTO rate_limits (client_id, window_start, count) VALUES (?, ?, 1)'
    ).bind(clientId, windowStart).run();
  } else {
    await db.prepare(
      'UPDATE rate_limits SET count = count + 1 WHERE client_id = ? AND window_start = ?'
    ).bind(clientId, windowStart).run();
  }

  return { allowed: true, remaining: maxPerHour - (currentCount + 1) };
}
