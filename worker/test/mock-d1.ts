// worker/test/mock-d1.ts
// In-memory mock for Cloudflare D1Database for unit testing

export class MockD1Database {
  private tables: {
    clients: Map<string, any>;
    rules: Map<string, any>;
    notifications: Map<string, any>;
    drafts: Map<string, any>;
    digests: Map<string, any>;
    eval_runs: Map<string, any>;
    rate_limits: Map<string, any>;
  };

  constructor() {
    this.tables = {
      clients: new Map(),
      rules: new Map(),
      notifications: new Map(),
      drafts: new Map(),
      digests: new Map(),
      eval_runs: new Map(),
      rate_limits: new Map(),
    };
  }

  prepare(query: string) {
    return new MockD1PreparedStatement(this.tables, query);
  }

  async batch(statements: MockD1PreparedStatement[]) {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }
}

class MockD1PreparedStatement {
  private tables: Record<string, Map<string, any>>;
  private query: string;
  private bindings: any[] = [];

  constructor(tables: Record<string, Map<string, any>>, query: string) {
    this.tables = tables;
    this.query = query;
  }

  bind(...args: any[]) {
    this.bindings = args;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const res = await this.all<T>();
    return res.results && res.results.length > 0 ? res.results[0] : null;
  }

  async all<T = unknown>(): Promise<{ results: T[]; meta?: any }> {
    const q = this.query.trim();

    // SELECT id, settings_json FROM clients WHERE id = ?
    if (/SELECT .* FROM clients WHERE id = \?/i.test(q)) {
      const clientId = this.bindings[0];
      const client = this.tables.clients.get(clientId);
      return { results: client ? [client as T] : [] };
    }

    // SELECT * FROM rules WHERE client_id = ? ORDER BY priority DESC, created_at ASC
    if (/SELECT \* FROM rules WHERE client_id = \?/i.test(q)) {
      const clientId = this.bindings[0];
      const rules = Array.from(this.tables.rules.values())
        .filter((r) => r.client_id === clientId)
        .sort((a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at));
      return { results: rules as T[] };
    }

    // SELECT * FROM rules WHERE id = ? AND client_id = ?
    if (/SELECT \* FROM rules WHERE id = \? AND client_id = \?/i.test(q)) {
      const [id, clientId] = this.bindings;
      const rule = this.tables.rules.get(id);
      if (rule && rule.client_id === clientId) {
        return { results: [rule as T] };
      }
      return { results: [] };
    }

    // SELECT count FROM rate_limits WHERE client_id = ? AND window_start = ?
    if (/SELECT count FROM rate_limits WHERE client_id = \? AND window_start = \?/i.test(q)) {
      const [clientId, windowStart] = this.bindings;
      const key = `${clientId}:${windowStart}`;
      const entry = this.tables.rate_limits.get(key);
      return { results: entry ? [entry as T] : [] };
    }

    // SELECT * FROM notifications WHERE id = ? AND client_id = ?
    if (/SELECT .* FROM notifications WHERE id = \? AND client_id = \?/i.test(q)) {
      const [id, clientId] = this.bindings;
      const notif = this.tables.notifications.get(id);
      if (notif && notif.client_id === clientId) {
        return { results: [notif as T] };
      }
      return { results: [] };
    }

    // SELECT * FROM notifications WHERE client_id = ? AND dedupe_hash = ? AND received_at >= ?
    if (/SELECT .* FROM notifications WHERE client_id = \? AND dedupe_hash = \? AND received_at >= \?/i.test(q)) {
      const [clientId, dedupeHash, cutoff] = this.bindings;
      const match = Array.from(this.tables.notifications.values()).find(
        (n) => n.client_id === clientId && n.dedupe_hash === dedupeHash && n.received_at >= cutoff
      );
      return { results: match ? [match as T] : [] };
    }

    // SELECT lane, user_lane, classifier, classify_ms, received_at FROM notifications WHERE client_id = ? AND received_at >= ?
    if (/SELECT .* FROM notifications WHERE client_id = \? AND received_at >= \?/i.test(q)) {
      const [clientId, cutoff] = this.bindings;
      const items = Array.from(this.tables.notifications.values()).filter(
        (n) => n.client_id === clientId && n.received_at >= cutoff
      );
      return { results: items as T[] };
    }

    // Dynamic SELECT * FROM notifications WHERE ...
    if (/SELECT .* FROM notifications WHERE client_id = \?/i.test(q)) {
      const clientId = this.bindings[0];
      let items = Array.from(this.tables.notifications.values()).filter((n) => n.client_id === clientId);

      let bindIdx = 1;
      if (/lane = \?/i.test(q)) {
        const lane = this.bindings[bindIdx++];
        items = items.filter((n) => n.lane === lane);
      }
      if (/status = \?/i.test(q)) {
        const status = this.bindings[bindIdx++];
        items = items.filter((n) => n.status === status);
      }
      if (/received_at < \?/i.test(q)) {
        const before = this.bindings[bindIdx++];
        items = items.filter((n) => n.received_at < before);
      }

      items.sort((a, b) => b.received_at.localeCompare(a.received_at));

      if (/LIMIT \?/i.test(q)) {
        const limit = this.bindings[bindIdx++];
        if (typeof limit === 'number') {
          items = items.slice(0, limit);
        }
      }

      return { results: items as T[] };
    }

    // SELECT id, settings_json FROM clients
    if (/SELECT id, settings_json FROM clients/i.test(q)) {
      const allClients = Array.from(this.tables.clients.values());
      return { results: allClients as T[] };
    }

    // SELECT * FROM digests WHERE client_id = ? AND status = ?
    if (/SELECT .* FROM digests WHERE client_id = \? AND status = \?/i.test(q)) {
      const [clientId, status] = this.bindings;
      const list = Array.from(this.tables.digests.values())
        .filter((d) => d.client_id === clientId && d.status === status)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { results: list as T[] };
    }

    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const q = this.query.trim();

    // INSERT INTO clients (id, created_at, last_seen_at, settings_json) VALUES (?, ?, ?, ?)
    if (/INSERT INTO clients/i.test(q)) {
      const [id, created_at, last_seen_at, settings_json] = this.bindings;
      this.tables.clients.set(id, { id, created_at, last_seen_at, settings_json });
      return { meta: { changes: 1 } };
    }

    // UPDATE clients SET settings_json = ?, last_seen_at = ? WHERE id = ?
    if (/UPDATE clients SET settings_json/i.test(q)) {
      const [settings_json, last_seen_at, id] = this.bindings;
      const existing = this.tables.clients.get(id) || { id, created_at: last_seen_at };
      this.tables.clients.set(id, { ...existing, settings_json, last_seen_at });
      return { meta: { changes: 1 } };
    }

    // UPDATE clients SET last_seen_at = ? WHERE id = ?
    if (/UPDATE clients SET last_seen_at/i.test(q)) {
      const [last_seen_at, id] = this.bindings;
      const existing = this.tables.clients.get(id);
      if (existing) {
        existing.last_seen_at = last_seen_at;
        this.tables.clients.set(id, existing);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    // INSERT INTO rules
    if (/INSERT INTO rules/i.test(q)) {
      const [id, client_id, type, pattern, action, priority, enabled, created_at] = this.bindings;
      this.tables.rules.set(id, { id, client_id, type, pattern, action, priority, enabled, created_at });
      return { meta: { changes: 1 } };
    }

    // UPDATE rules SET type = ?, pattern = ?, action = ?, priority = ?, enabled = ? WHERE id = ? AND client_id = ?
    if (/UPDATE rules SET type =/i.test(q)) {
      const [type, pattern, action, priority, enabled, id, client_id] = this.bindings;
      const existing = this.tables.rules.get(id);
      if (existing && existing.client_id === client_id) {
        this.tables.rules.set(id, { ...existing, type, pattern, action, priority, enabled });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    // DELETE FROM rules WHERE id = ? AND client_id = ?
    if (/DELETE FROM rules WHERE id = \? AND client_id = \?/i.test(q)) {
      const [id, client_id] = this.bindings;
      const existing = this.tables.rules.get(id);
      if (existing && existing.client_id === client_id) {
        this.tables.rules.delete(id);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    // INSERT INTO rate_limits (client_id, window_start, count) VALUES (?, ?, 1)
    if (/INSERT INTO rate_limits/i.test(q)) {
      const [clientId, windowStart] = this.bindings;
      const key = `${clientId}:${windowStart}`;
      this.tables.rate_limits.set(key, { client_id: clientId, window_start: windowStart, count: 1 });
      return { meta: { changes: 1 } };
    }

    // UPDATE rate_limits SET count = count + 1 WHERE client_id = ? AND window_start = ?
    if (/UPDATE rate_limits SET count = count \+ 1/i.test(q)) {
      const [clientId, windowStart] = this.bindings;
      const key = `${clientId}:${windowStart}`;
      const existing = this.tables.rate_limits.get(key) || { client_id: clientId, window_start: windowStart, count: 0 };
      existing.count += 1;
      this.tables.rate_limits.set(key, existing);
      return { meta: { changes: 1 } };
    }

    // INSERT INTO notifications
    if (/INSERT INTO notifications/i.test(q)) {
      const record: any = {
        id: this.bindings[0],
        client_id: this.bindings[1],
        received_at: this.bindings[2],
        source_domain: this.bindings[3],
        sender: this.bindings[4],
        title: this.bindings[5],
        body: this.bindings[6],
        dedupe_hash: this.bindings[7],
        classifier: this.bindings[8],
        lane: this.bindings[9],
        lane_reason: this.bindings[10],
        urgency: this.bindings[11],
        p_now: this.bindings[12],
        p_later: this.bindings[13],
        p_mute: this.bindings[14],
        p_time_sensitive: this.bindings[15],
        p_needs_reply: this.bindings[16],
        p_from_person: this.bindings[17],
        p_promotional: this.bindings[18],
        p_suspicious: this.bindings[19],
        answers_json: this.bindings[20],
        uncertain: this.bindings[21],
        suspicious: this.bindings[22],
        classify_ms: this.bindings[23],
        status: this.bindings[24],
        snooze_until: this.bindings[25],
        user_lane: this.bindings[26],
        created_at: this.bindings[27],
      };
      this.tables.notifications.set(record.id, record);
      return { meta: { changes: 1 } };
    }

    // INSERT INTO drafts
    if (/INSERT INTO drafts/i.test(q)) {
      const [id, notification_id, tone, text, model, latency_ms, created_at] = this.bindings;
      this.tables.drafts.set(id, { id, notification_id, tone, text, model, latency_ms, created_at });
      return { meta: { changes: 1 } };
    }

    // INSERT INTO digests
    if (/INSERT INTO digests/i.test(q)) {
      const [id, client_id, created_at, status] = this.bindings;
      this.tables.digests.set(id, { id, client_id, created_at, status: status || 'pending' });
      return { meta: { changes: 1 } };
    }

    // UPDATE digests
    if (/UPDATE digests/i.test(q)) {
      if (/SET status = 'completed'/i.test(q)) {
        const [item_count, summary_json, period_start, period_end, id] = this.bindings;
        const digest = this.tables.digests.get(id) || { id };
        this.tables.digests.set(id, {
          ...digest,
          status: 'completed',
          item_count,
          summary_json,
          period_start,
          period_end,
        });
        return { meta: { changes: 1 } };
      }
      if (/SET status = 'failed'/i.test(q)) {
        const [id] = this.bindings;
        const digest = this.tables.digests.get(id) || { id };
        this.tables.digests.set(id, { ...digest, status: 'failed' });
        return { meta: { changes: 1 } };
      }
    }

    // INSERT INTO eval_runs
    if (/INSERT INTO eval_runs/i.test(q)) {
      const [id, client_id, created_at, classifier, n, accuracy, false_mute_rate, results_json] = this.bindings;
      this.tables.eval_runs.set(id, { id, client_id, created_at, classifier, n, accuracy, false_mute_rate, results_json });
      return { meta: { changes: 1 } };
    }


    // UPDATE notifications SET status = ?, snooze_until = ?, lane = ?, user_lane = ?, lane_reason = ? WHERE id = ? AND client_id = ?
    if (/UPDATE\s+notifications\s+SET[\s\S]*status\s*=\s*\?[\s\S]*WHERE\s+id\s*=\s*\?\s+AND\s+client_id\s*=\s*\?/i.test(q)) {
      const [status, snooze_until, lane, user_lane, lane_reason, id, client_id] = this.bindings;
      const notif = this.tables.notifications.get(id);
      if (notif && notif.client_id === client_id) {
        notif.status = status;
        notif.snooze_until = snooze_until;
        notif.lane = lane;
        notif.user_lane = user_lane;
        notif.lane_reason = lane_reason;
        this.tables.notifications.set(id, notif);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    // Resurface snoozed: UPDATE notifications SET status = 'open', lane = 'now', lane_reason = 'snooze_resurfaced', snooze_until = NULL WHERE status = 'snoozed' ...
    if (/UPDATE notifications[\s\S]*snooze_resurfaced/i.test(q)) {
      const [now] = this.bindings;
      let count = 0;
      for (const [id, notif] of this.tables.notifications.entries()) {
        if (notif.status === 'snoozed' && notif.snooze_until && notif.snooze_until <= now) {
          notif.status = 'open';
          notif.lane = 'now';
          notif.lane_reason = 'snooze_resurfaced';
          notif.snooze_until = null;
          this.tables.notifications.set(id, notif);
          count++;
        }
      }
      return { meta: { changes: count } };
    }

    // Retention: UPDATE notifications SET body = NULL WHERE client_id = ? AND received_at < ? AND body IS NOT NULL
    if (/UPDATE notifications SET body = NULL/i.test(q)) {
      const [clientId, cutoff] = this.bindings;
      let count = 0;
      for (const [id, notif] of this.tables.notifications.entries()) {
        if (notif.client_id === clientId && notif.received_at < cutoff && notif.body !== null) {
          notif.body = null;
          this.tables.notifications.set(id, notif);
          count++;
        }
      }
      return { meta: { changes: count } };
    }

    // Retention purge: DELETE FROM notifications WHERE received_at < ?
    if (/DELETE FROM notifications WHERE received_at < \?/i.test(q)) {
      const [cutoff] = this.bindings;
      let count = 0;
      for (const [id, notif] of this.tables.notifications.entries()) {
        if (notif.received_at < cutoff) {
          this.tables.notifications.delete(id);
          count++;
        }
      }
      return { meta: { changes: count } };
    }

    // DELETE FROM clients WHERE id = ?
    if (/DELETE FROM clients WHERE id = \?/i.test(q)) {
      const [clientId] = this.bindings;
      const had = this.tables.clients.delete(clientId);
      // cascade rules
      for (const [rid, rule] of this.tables.rules.entries()) {
        if (rule.client_id === clientId) this.tables.rules.delete(rid);
      }
      // cascade notifications
      for (const [nid, notif] of this.tables.notifications.entries()) {
        if (notif.client_id === clientId) this.tables.notifications.delete(nid);
      }
      return { meta: { changes: had ? 1 : 0 } };
    }

    // DELETE FROM rate_limits WHERE client_id = ?
    if (/DELETE FROM rate_limits WHERE client_id = \?/i.test(q)) {
      const [clientId] = this.bindings;
      let count = 0;
      for (const [key, rl] of this.tables.rate_limits.entries()) {
        if (rl.client_id === clientId) {
          this.tables.rate_limits.delete(key);
          count++;
        }
      }
      return { meta: { changes: count } };
    }

    return { meta: { changes: 0 } };
  }
}

