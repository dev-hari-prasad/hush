// worker/test/phase4.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { app } from '../src/index';
import { MockD1Database } from './mock-d1';
import { Env } from '../src/types';

describe('Phase 4: LLM Draft Replies, Conversational Q&A & Digest Workflow', () => {
  let mockDb: MockD1Database;
  let env: Env;
  const clientId = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    mockDb = new MockD1Database();
    env = {
      DB: mockDb as any,
      JEV_MODE: 'heuristic',
      NOW_THRESHOLD: '0.6',
      MUTE_THRESHOLD: '0.8',
    };
  });

  describe('Draft Reply Generation', () => {
    it('generates brief, friendly, and formal response drafts and persists to database', async () => {
      // Ingest a notification first
      const createRes = await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'slack.com' },
            sender: 'sarah',
            title: 'Hey, do you have time for a sync?',
            body: 'Need to review the Q3 roadmap proposal.',
          }),
        },
        env
      );
      const notif = await createRes.json();

      // Request brief draft
      const briefRes = await app.request(
        `/v1/notifications/${notif.id}/draft-reply`,
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tone: 'brief' }),
        },
        env
      );
      expect(briefRes.status).toBe(200);
      const briefDraft = await briefRes.json();
      expect(briefDraft.id).toBeDefined();
      expect(briefDraft.tone).toBe('brief');
      expect(briefDraft.text).toContain('Got it');

      // Request friendly draft
      const friendlyRes = await app.request(
        `/v1/notifications/${notif.id}/draft-reply`,
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tone: 'friendly' }),
        },
        env
      );
      const friendlyDraft = await friendlyRes.json();
      expect(friendlyDraft.tone).toBe('friendly');
      expect(friendlyDraft.text).toContain('Thanks for reaching out');

      // Verify draft persisted in database
      const dbDraft = (mockDb as any).tables.drafts.get(briefDraft.id);
      expect(dbDraft).toBeDefined();
      expect(dbDraft.notification_id).toBe(notif.id);
    });

    it('returns 404 for non-existent notification ID', async () => {
      const res = await app.request(
        '/v1/notifications/non-existent-id/draft-reply',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tone: 'brief' }),
        },
        env
      );
      expect(res.status).toBe(404);
    });
  });

  describe('Ask LLM About Notifications (Conversational Q&A)', () => {
    it('answers queries about recent notifications safely', async () => {
      // Ingest some notifications
      await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'pagerduty.com' },
            title: 'Critical Alert: DB cluster high memory',
            body: 'Node db-01 memory at 94%',
          }),
        },
        env
      );

      const queryRes = await app.request(
        '/v1/notifications/query',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'Did any urgent alerts arrive regarding the database?',
          }),
        },
        env
      );

      expect(queryRes.status).toBe(200);
      const queryJson = await queryRes.json();
      expect(queryJson.query).toContain('urgent alerts');
      expect(queryJson.answer).toBeDefined();
      expect(queryJson.items_analyzed).toBe(1);
    });

    it('rejects empty queries with 400', async () => {
      const res = await app.request(
        '/v1/notifications/query',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '' }),
        },
        env
      );
      expect(res.status).toBe(400);
    });
  });

  describe('Digest Pipeline & Endpoints', () => {
    it('runs digest workflow, summarizes later items, and makes available at /v1/digest/latest', async () => {
      // Ingest batch of later items
      await app.request(
        '/v1/notifications/batch',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notifications: [
              {
                source: { domain: 'github.com' },
                title: 'PR #42 review requested',
                body: 'Please check auth middleware update',
              },
              {
                source: { domain: 'github.com' },
                title: 'PR #43 merged into staging',
                body: 'CI verified all tests pass',
              },
            ],
          }),
        },
        env
      );

      // Trigger digest run
      const runRes = await app.request(
        '/v1/digest/run',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId },
        },
        env
      );
      expect(runRes.status).toBe(200);
      const runJson = await runRes.json();
      expect(runJson.success).toBe(true);
      expect(runJson.digest.status).toBe('completed');
      expect(runJson.digest.item_count).toBe(2);

      // Verify retrieval via /v1/digest/latest
      const latestRes = await app.request(
        '/v1/digest/latest',
        {
          method: 'GET',
          headers: { 'X-Client-Id': clientId },
        },
        env
      );
      expect(latestRes.status).toBe(200);
      const latestJson = await latestRes.json();
      expect(latestJson.digest).toBeDefined();
      expect(latestJson.digest.id).toBe(runJson.digest.id);

      const parsedSummary = JSON.parse(latestJson.digest.summary_json);
      expect(parsedSummary.summary).toBeDefined();
      expect(parsedSummary.groups).toBeDefined();
    });

    it('handles empty later lane gracefully', async () => {
      const runRes = await app.request(
        '/v1/digest/run',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId },
        },
        env
      );
      expect(runRes.status).toBe(200);
      const runJson = await runRes.json();
      expect(runJson.digest.item_count).toBe(0);
      const summary = JSON.parse(runJson.digest.summary_json);
      expect(summary.summary).toContain('No unread notifications');
    });
  });

  describe('BYOK OpenAI-compatible Base URL Dispatch', () => {
    it('calls external custom OpenAI-compatible endpoint when configured in settings', async () => {
      // Configure BYOK settings
      await app.request(
        '/v1/settings',
        {
          method: 'PUT',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            llm_base_url: 'https://custom-openai-provider.example.com/v1',
            llm_api_key: 'custom-oai-api-key',
            llm_model: 'llama-3.1-custom',
          }),
        },
        env
      );

      // Mock fetch for custom LLM endpoint
      const originalFetch = globalThis.fetch;
      const customFetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Custom BYOK LLM response generated.' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      globalThis.fetch = customFetchMock;

      // Ingest notification
      const notifRes = await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'linear.app' },
            title: 'Fix auth bug',
          }),
        },
        env
      );
      const notif = await notifRes.json();

      // Request draft reply
      const draftRes = await app.request(
        `/v1/notifications/${notif.id}/draft-reply`,
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tone: 'brief' }),
        },
        env
      );

      expect(draftRes.status).toBe(200);
      const draft = await draftRes.json();
      expect(draft.text).toBe('Custom BYOK LLM response generated.');
      expect(customFetchMock).toHaveBeenCalled();

      // Check request URL was custom endpoint
      const calledUrl = customFetchMock.mock.calls[0][0];
      expect(calledUrl).toBe('https://custom-openai-provider.example.com/v1/chat/completions');

      globalThis.fetch = originalFetch;
    });
  });
});
