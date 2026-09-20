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

    // DELETE FROM clients WHERE id = ?
    if (/DELETE FROM clients WHERE id = \?/i.test(q)) {
      const [clientId] = this.bindings;
      const had = this.tables.clients.delete(clientId);
      // cascade rules
      for (const [rid, rule] of this.tables.rules.entries()) {
        if (rule.client_id === clientId) this.tables.rules.delete(rid);
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
