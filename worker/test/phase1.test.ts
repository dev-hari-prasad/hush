// worker/test/phase1.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { MockD1Database } from './mock-d1';
import { Env } from '../src/types';

describe('Phase 1: Scaffolding, Auth, Settings, Rules & Rate Limiting', () => {
  let mockDb: MockD1Database;
  let env: Env;
  const validClientId = '123e4567-e89b-12d3-a456-426614174000';
  const otherClientId = '987fcdeb-51a2-43f7-9876-543210987654';

  beforeEach(() => {
    mockDb = new MockD1Database();
    env = {
      DB: mockDb as any,
      JEV_MODE: 'heuristic',
      NOW_THRESHOLD: '0.6',
      MUTE_THRESHOLD: '0.8',
    };
  });

  describe('Client Authentication Middleware', () => {
    it('returns 401 when X-Client-Id header is missing', async () => {
      const res = await app.request('/v1/settings', { method: 'GET' }, env);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ error: 'Missing or invalid X-Client-Id header. Expected a valid UUID.' });
    });

    it('returns 401 when X-Client-Id is not a valid UUID', async () => {
      const res = await app.request(
        '/v1/settings',
        { method: 'GET', headers: { 'X-Client-Id': 'not-a-valid-uuid' } },
        env
      );
      expect(res.status).toBe(401);
    });

    it('allows requests with valid UUID v4', async () => {
      const res = await app.request(
        '/v1/settings',
        { method: 'GET', headers: { 'X-Client-Id': validClientId } },
        env
      );
      expect(res.status).toBe(200);
    });
  });

  describe('Settings CRUD', () => {
    it('returns default settings for newly registered client', async () => {
      const res = await app.request(
        '/v1/settings',
        { method: 'GET', headers: { 'X-Client-Id': validClientId } },
        env
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.now_threshold).toBe(0.6);
      expect(json.mute_threshold).toBe(0.8);
      expect(json.redact).toBe(true);
      expect(json.retention_days).toBe(7);
      expect(json.jev_endpoint).toBe('https://api.typesafe.ai/v1/systemone');
      expect(json.llm_base_url).toContain('https://api.cloudflare.com/client/v4/accounts');
    });

    it('updates and persists settings including BYOK keys', async () => {
      const updatePayload = {
        priorities_text: 'Prioritize production incidents and messages from @alice',
        focus_mode: true,
        now_threshold: 0.7,
        jev_endpoint: 'https://custom-jev.example.com/v1',
        jev_api_key: 'custom-jev-secret',
        llm_base_url: 'https://custom-ai.example.com/v1',
        llm_api_key: 'custom-llm-secret',
      };

      const putRes = await app.request(
        '/v1/settings',
        {
          method: 'PUT',
          headers: {
            'X-Client-Id': validClientId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updatePayload),
        },
        env
      );

      expect(putRes.status).toBe(200);
      const updated = await putRes.json();
      expect(updated.priorities_text).toBe(updatePayload.priorities_text);
      expect(updated.focus_mode).toBe(true);
      expect(updated.now_threshold).toBe(0.7);
      expect(updated.jev_endpoint).toBe(updatePayload.jev_endpoint);
      expect(updated.jev_api_key).toBe('custom-jev-secret');
      expect(updated.llm_base_url).toBe(updatePayload.llm_base_url);

      // Verify retrieval returns persisted settings
      const getRes = await app.request(
        '/v1/settings',
        { method: 'GET', headers: { 'X-Client-Id': validClientId } },
        env
      );
      const fetched = await getRes.json();
      expect(fetched.now_threshold).toBe(0.7);
      expect(fetched.jev_api_key).toBe('custom-jev-secret');
    });

    it('rejects invalid threshold values', async () => {
      const invalidRes = await app.request(
        '/v1/settings',
        {
          method: 'PUT',
          headers: {
            'X-Client-Id': validClientId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ now_threshold: 1.5 }),
        },
        env
      );
      expect(invalidRes.status).toBe(400);
      const json = await invalidRes.json();
      expect(json.error).toContain('now_threshold must be a number between 0 and 1');
    });
  });

  describe('Rules CRUD', () => {
    it('creates rules with validation', async () => {
      const createRes = await app.request(
        '/v1/rules',
        {
          method: 'POST',
          headers: {
            'X-Client-Id': validClientId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'sender',
            pattern: 'alice@company.com',
            action: 'now',
            priority: 10,
          }),
        },
        env
      );

      expect(createRes.status).toBe(201);
      const rule = await createRes.json();
      expect(rule.id).toBeDefined();
      expect(rule.pattern).toBe('alice@company.com');
      expect(rule.priority).toBe(10);
      expect(rule.action).toBe('now');
    });

    it('validates rule creation parameters', async () => {
      const res = await app.request(
        '/v1/rules',
        {
          method: 'POST',
          headers: {
            'X-Client-Id': validClientId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'invalid-type',
            pattern: 'test',
            action: 'now',
          }),
        },
        env
      );
      expect(res.status).toBe(400);
    });

    it('lists rules ordered by priority and scoped to client', async () => {
      // Add low priority rule for validClient
      await app.request(
        '/v1/rules',
        {
          method: 'POST',
          headers: { 'X-Client-Id': validClientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'domain', pattern: 'marketing.com', action: 'mute', priority: 1 }),
        },
        env
      );

      // Add high priority rule for validClient
      await app.request(
        '/v1/rules',
        {
          method: 'POST',
          headers: { 'X-Client-Id': validClientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'keyword', pattern: 'FIRE', action: 'now', priority: 100 }),
        },
        env
      );

      // Add rule for otherClient (should not leak)
      await app.request(
        '/v1/rules',
        {
          method: 'POST',
          headers: { 'X-Client-Id': otherClientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'domain', pattern: 'other.com', action: 'later', priority: 50 }),
        },
        env
      );

      const listRes = await app.request(
        '/v1/rules',
        { method: 'GET', headers: { 'X-Client-Id': validClientId } },
        env
      );
      expect(listRes.status).toBe(200);
      const rules = await listRes.json();
      expect(rules.length).toBe(2);
      expect(rules[0].priority).toBe(100);
      expect(rules[1].priority).toBe(1);
    });

    it('updates and deletes existing rule', async () => {
      const createRes = await app.request(
        '/v1/rules',
        {
          method: 'POST',
          headers: { 'X-Client-Id': validClientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'domain', pattern: 'example.com', action: 'later' }),
        },
        env
      );
      const created = await createRes.json();

      const updateRes = await app.request(
        `/v1/rules/${created.id}`,
        {
          method: 'PUT',
          headers: { 'X-Client-Id': validClientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'mute', priority: 5 }),
        },
        env
      );
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.action).toBe('mute');
      expect(updated.priority).toBe(5);

      const deleteRes = await app.request(
        `/v1/rules/${created.id}`,
        { method: 'DELETE', headers: { 'X-Client-Id': validClientId } },
        env
      );
      expect(deleteRes.status).toBe(200);

      const listRes = await app.request(
        '/v1/rules',
        { method: 'GET', headers: { 'X-Client-Id': validClientId } },
        env
      );
      const remaining = await listRes.json();
      expect(remaining.find((r: any) => r.id === created.id)).toBeUndefined();
    });
  });

  describe('Rate Limiting & Data Wipe', () => {
    it('applies client rate limit header on notification routes', async () => {
      const res = await app.request(
        '/v1/notifications/test',
        { method: 'GET', headers: { 'X-Client-Id': validClientId } },
        env
      );
      expect(res.headers.get('X-RateLimit-Limit')).toBe('120');
      expect(res.headers.get('X-RateLimit-Remaining')).toBeDefined();
    });

    it('wipes all client data on DELETE /v1/data', async () => {
      // Create a rule first
      await app.request(
        '/v1/rules',
        {
          method: 'POST',
          headers: { 'X-Client-Id': validClientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'sender', pattern: 'bot@ci.com', action: 'later' }),
        },
        env
      );

      const wipeRes = await app.request(
        '/v1/data',
        { method: 'DELETE', headers: { 'X-Client-Id': validClientId } },
        env
      );
      expect(wipeRes.status).toBe(200);
      const wipeJson = await wipeRes.json();
      expect(wipeJson.success).toBe(true);

      // Verify rules are empty
      const rulesRes = await app.request(
        '/v1/rules',
        { method: 'GET', headers: { 'X-Client-Id': validClientId } },
        env
      );
      const rules = await rulesRes.json();
      expect(rules.length).toBe(0);
    });
  });
});
