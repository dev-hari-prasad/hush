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

export async function computeDedupeHash(
  clientId: string,
  domain: string,
  sender: string | undefined | null,
  title: string,
  body: string | undefined | null
): Promise<string> {
  const norm = `${clientId}|${domain.toLowerCase()}|${(sender || '').toLowerCase()}|${title.trim().toLowerCase()}|${(body || '').trim().slice(0, 100).toLowerCase()}`;
  const msgUint8 = new TextEncoder().encode(norm);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function checkDuplicateNotification(
  db: D1Database,
  clientId: string,
  dedupeHash: string,
  windowSeconds = 300
): Promise<NotificationRecord | null> {
  const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();

  const match = await db.prepare(
    'SELECT * FROM notifications WHERE client_id = ? AND dedupe_hash = ? AND received_at >= ? LIMIT 1'
  )
    .bind(clientId, dedupeHash, cutoff)
    .first<NotificationRecord>();

  return match || null;
}

export async function insertNotificationRecord(
  db: D1Database,
  record: NotificationRecord
): Promise<void> {
  await db.prepare(
    `INSERT INTO notifications (
      id, client_id, received_at, source_domain, sender, title, body,
      dedupe_hash, classifier, lane, lane_reason, urgency,
      p_now, p_later, p_mute, p_time_sensitive, p_needs_reply, p_from_person,
      p_promotional, p_suspicious, answers_json, uncertain, suspicious,
      classify_ms, status, snooze_until, user_lane, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )`
  )
    .bind(
      record.id,
      record.client_id,
      record.received_at,
      record.source_domain,
      record.sender,
      record.title,
      record.body,
      record.dedupe_hash,
      record.classifier,
      record.lane,
      record.lane_reason,
      record.urgency,
      record.p_now,
      record.p_later,
      record.p_mute,
      record.p_time_sensitive,
      record.p_needs_reply,
      record.p_from_person,
      record.p_promotional,
      record.p_suspicious,
      record.answers_json,
      record.uncertain,
      record.suspicious,
      record.classify_ms,
      record.status,
      record.snooze_until,
      record.user_lane,
      record.created_at
    )
    .run();
}

export async function getNotifications(
  db: D1Database,
  clientId: string,
  options: {
    lane?: string;
    status?: string;
    limit?: number;
    before?: string;
  }
): Promise<{ notifications: NotificationRecord[]; has_more: boolean }> {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  const conditions = ['client_id = ?'];
  const bindings: any[] = [clientId];

  if (options.lane) {
    conditions.push('lane = ?');
    bindings.push(options.lane);
  }

  if (options.status) {
    conditions.push('status = ?');
    bindings.push(options.status);
  }

  if (options.before) {
    conditions.push('received_at < ?');
    bindings.push(options.before);
  }

  const whereClause = conditions.join(' AND ');
  // Fetch limit + 1 to detect has_more
  const query = `SELECT * FROM notifications WHERE ${whereClause} ORDER BY received_at DESC LIMIT ?`;
  bindings.push(limit + 1);

  const stmt = db.prepare(query);
  const result = await stmt.bind(...bindings).all<NotificationRecord>();
  const rows = result.results || [];

  const has_more = rows.length > limit;
  const notifications = has_more ? rows.slice(0, limit) : rows;

  return { notifications, has_more };
}

export async function getNotificationById(
  db: D1Database,
  clientId: string,
  id: string
): Promise<NotificationRecord | null> {
  const notif = await db.prepare('SELECT * FROM notifications WHERE id = ? AND client_id = ?')
    .bind(id, clientId)
    .first<NotificationRecord>();

  return notif || null;
}

export async function updateNotificationAction(
  db: D1Database,
  clientId: string,
  id: string,
  updates: {
    status?: 'open' | 'done' | 'snoozed';
    snooze_until?: string | null;
    lane?: 'now' | 'later' | 'mute';
    user_lane?: 'now' | 'later' | 'mute';
    lane_reason?: string;
  }
): Promise<NotificationRecord | null> {
  const existing = await getNotificationById(db, clientId, id);
  if (!existing) return null;

  const status = updates.status ?? existing.status;
  const snooze_until = updates.snooze_until !== undefined ? updates.snooze_until : existing.snooze_until;
  const lane = updates.lane ?? existing.lane;
  const user_lane = updates.user_lane !== undefined ? updates.user_lane : existing.user_lane;
  const lane_reason = updates.lane_reason ?? existing.lane_reason;

  await db.prepare(
    `UPDATE notifications SET
      status = ?,
      snooze_until = ?,
      lane = ?,
      user_lane = ?,
      lane_reason = ?
    WHERE id = ? AND client_id = ?`
  )
    .bind(status, snooze_until, lane, user_lane, lane_reason, id, clientId)
    .run();

  return {
    ...existing,
    status,
    snooze_until,
    lane,
    user_lane,
    lane_reason,
  };
}

export async function resurfaceSnoozedNotifications(db: D1Database): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `UPDATE notifications
     SET status = 'open',
         lane = 'now',
         lane_reason = 'snooze_resurfaced',
         snooze_until = NULL
     WHERE status = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?`
  )
    .bind(now)
    .run();

  return res.meta?.changes ?? 0;
}

export async function runRetentionCleanup(db: D1Database): Promise<{ bodiesNullified: number; rowsDeleted: number }> {
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 86400 * 1000).toISOString();

  // Delete notifications older than 30 days
  const delRes = await db.prepare('DELETE FROM notifications WHERE received_at < ?')
    .bind(thirtyDaysAgo)
    .run();
  const rowsDeleted = delRes.meta?.changes ?? 0;

  // For each client, check retention_days and nullify bodies
  const clients = await db.prepare('SELECT id, settings_json FROM clients').all<{ id: string; settings_json: string }>();
  let bodiesNullified = 0;

  for (const client of (clients.results || [])) {
    let retentionDays = 7;
    try {
      const parsed = JSON.parse(client.settings_json || '{}');
      if (typeof parsed.retention_days === 'number' && parsed.retention_days > 0) {
        retentionDays = parsed.retention_days;
      }
    } catch {
      retentionDays = 7;
    }

    const retentionCutoff = new Date(now - retentionDays * 86400 * 1000).toISOString();
    const nullRes = await db.prepare(
      'UPDATE notifications SET body = NULL WHERE client_id = ? AND received_at < ? AND body IS NOT NULL'
    )
      .bind(client.id, retentionCutoff)
      .run();

    bodiesNullified += nullRes.meta?.changes ?? 0;
  }

  return { bodiesNullified, rowsDeleted };
}

export async function getClientStats(
  db: D1Database,
  clientId: string,
  window: '1h' | '24h' | '7d' = '24h'
): Promise<any> {
  const msMap = {
    '1h': 3600 * 1000,
    '24h': 24 * 3600 * 1000,
    '7d': 7 * 24 * 3600 * 1000,
  };
  const durationMs = msMap[window] || msMap['24h'];
  const cutoff = new Date(Date.now() - durationMs).toISOString();

  const records = (await db.prepare(
    'SELECT lane, user_lane, classifier, classify_ms, received_at FROM notifications WHERE client_id = ? AND received_at >= ?'
  )
    .bind(clientId, cutoff)
    .all<{ lane: string; user_lane: string | null; classifier: string; classify_ms: number | null; received_at: string }>())
    .results || [];

  const total = records.length;
  let nowCount = 0;
  let laterCount = 0;
  let muteCount = 0;
  let overrides = 0;
  let falseMutes = 0;
  const latencies: number[] = [];
  const classifierMix: Record<string, number> = { jev: 0, heuristic: 0, heuristic_fallback: 0, rule: 0 };

  for (const r of records) {
    if (r.lane === 'now') nowCount++;
    else if (r.lane === 'later') laterCount++;
    else if (r.lane === 'mute') muteCount++;

    if (r.user_lane && r.user_lane !== r.lane) {
      overrides++;
      if (r.lane === 'mute' && (r.user_lane === 'now' || r.user_lane === 'later')) {
        falseMutes++;
      }
    }

    if (typeof r.classify_ms === 'number') {
      latencies.push(r.classify_ms);
    }

    if (classifierMix[r.classifier] !== undefined) {
      classifierMix[r.classifier]++;
    } else {
      classifierMix[r.classifier] = 1;
    }
  }

  // Latency percentiles
  latencies.sort((a, b) => a - b);
  const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  const interruptionsAvoided = total > 0 ? ((laterCount + muteCount) / total) * 100 : 0;
  const overrideRate = total > 0 ? (overrides / total) * 100 : 0;
  const fallbackRate = total > 0 ? ((classifierMix.heuristic_fallback || 0) / total) * 100 : 0;

  return {
    window,
    total,
    lanes: {
      now: nowCount,
      later: laterCount,
      mute: muteCount,
    },
    interruptions_avoided_pct: Number(interruptionsAvoided.toFixed(1)),
    override_rate_pct: Number(overrideRate.toFixed(1)),
    user_corrected_false_mutes: falseMutes,
    latency_ms: {
      p50,
      p95,
    },
    classifier_mix: classifierMix,
    fallback_rate_pct: Number(fallbackRate.toFixed(1)),
  };
}

export async function getLatestDigest(
  db: D1Database,
  clientId: string
): Promise<DigestRecord | null> {
  const row = await db.prepare(
    'SELECT * FROM digests WHERE client_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
  )
    .bind(clientId, 'completed')
    .first<DigestRecord>();

  return row || null;
}



