// worker/test/phase3.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import worker from '../src/index';
import { MockD1Database } from './mock-d1';
import { Env } from '../src/types';

describe('Phase 3: List, Actions, Snooze Cron, Stats & Simulator', () => {
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

  describe('Notification Listing & Filtering', () => {
    it('lists notifications filtered by lane and status', async () => {
      // Ingest one urgent security alert (now)
      await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'aws.amazon.com' },
            title: 'Security Alert: Root access',
            body: 'Unrecognized IP login',
          }),
        },
        env
      );

      // Ingest one marketing notification (mute)
      await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'shop.com' },
            title: 'Weekly newsletter with 50% off deals',
            body: 'Limited time coupon code inside',
          }),
        },
        env
      );

      // List all
      const allRes = await app.request(
        '/v1/notifications',
        { method: 'GET', headers: { 'X-Client-Id': clientId } },
        env
      );
      expect(allRes.status).toBe(200);
      const allJson = await allRes.json();
      expect(allJson.notifications.length).toBe(2);

      // Filter by lane=now
      const nowRes = await app.request(
        '/v1/notifications?lane=now',
        { method: 'GET', headers: { 'X-Client-Id': clientId } },
        env
      );
      const nowJson = await nowRes.json();
      expect(nowJson.notifications.length).toBe(1);
      expect(nowJson.notifications[0].lane).toBe('now');

      // Filter by lane=mute
      const muteRes = await app.request(
        '/v1/notifications?lane=mute',
        { method: 'GET', headers: { 'X-Client-Id': clientId } },
        env
      );
      const muteJson = await muteRes.json();
      expect(muteJson.notifications.length).toBe(1);
      expect(muteJson.notifications[0].lane).toBe('mute');
    });
  });

  describe('Notification Actions', () => {
    it('marks notification as done', async () => {
      const createRes = await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'linear.app' },
            title: 'ENG-101 assigned',
            body: 'Fix notification latency',
          }),
        },
        env
      );
      const notif = await createRes.json();

      const actionRes = await app.request(
        `/v1/notifications/${notif.id}/action`,
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'done' }),
        },
        env
      );

      expect(actionRes.status).toBe(200);
      const actionJson = await actionRes.json();
      expect(actionJson.success).toBe(true);
      expect(actionJson.notification.status).toBe('done');
    });

    it('snoozes notification until specified timestamp', async () => {
      const createRes = await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'slack.com' },
            title: 'Reminder to submit timesheet',
          }),
        },
        env
      );
      const notif = await createRes.json();

      const snoozeUntil = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
      const actionRes = await app.request(
        `/v1/notifications/${notif.id}/action`,
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'snooze', until: snoozeUntil }),
        },
        env
      );

      expect(actionRes.status).toBe(200);
      const actionJson = await actionRes.json();
      expect(actionJson.notification.status).toBe('snoozed');
      expect(actionJson.notification.snooze_until).toBe(snoozeUntil);
    });

    it('moves notification lane and records user_lane feedback', async () => {
      const createRes = await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'github.com' },
            title: 'Build succeeded',
          }),
        },
        env
      );
      const notif = await createRes.json();
      expect(notif.lane).toBe('later');

      // User moves it to 'now'
      const actionRes = await app.request(
        `/v1/notifications/${notif.id}/action`,
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'move', lane: 'now' }),
        },
        env
      );

      expect(actionRes.status).toBe(200);
      const actionJson = await actionRes.json();
      expect(actionJson.notification.lane).toBe('now');
      expect(actionJson.notification.user_lane).toBe('now');
    });

    it('mutes source and creates a persistent rule', async () => {
      const createRes = await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'spammy-site.com' },
            title: 'Check out our new products',
          }),
        },
        env
      );
      const notif = await createRes.json();

      const actionRes = await app.request(
        `/v1/notifications/${notif.id}/action`,
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'mute_source' }),
        },
        env
      );

      expect(actionRes.status).toBe(200);
      const actionJson = await actionRes.json();
      expect(actionJson.notification.lane).toBe('mute');
      expect(actionJson.rule_created).toBe('spammy-site.com');

      // Verify rule was added to database
      const rulesRes = await app.request(
        '/v1/rules',
        { method: 'GET', headers: { 'X-Client-Id': clientId } },
        env
      );
      const rules = await rulesRes.json();
      const matchingRule = rules.find((r: any) => r.pattern === 'spammy-site.com');
      expect(matchingRule).toBeDefined();
      expect(matchingRule.action).toBe('mute');
    });
  });

  describe('Scheduled Cron Triggers', () => {
    it('resurfaces snoozed items when snooze_until has elapsed', async () => {
      const createRes = await app.request(
        '/v1/notifications',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { domain: 'slack.com' },
            title: 'Snoozed task ping',
          }),
        },
        env
      );
      const notif = await createRes.json();

      // Snooze in the past (e.g. 5 minutes ago)
      const pastTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      await app.request(
        `/v1/notifications/${notif.id}/action`,
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'snooze', until: pastTime }),
        },
        env
      );

      // Trigger scheduled cron handler
      await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now(), type: 'scheduled' } as any, env, {} as any);

      // Check notification is now open and in 'now' lane
      const getRes = await app.request(
        '/v1/notifications?lane=now',
        { method: 'GET', headers: { 'X-Client-Id': clientId } },
        env
      );
      const getJson = await getRes.json();
      const resurfaced = getJson.notifications.find((n: any) => n.id === notif.id);
      expect(resurfaced).toBeDefined();
      expect(resurfaced.status).toBe('open');
      expect(resurfaced.lane_reason).toBe('snooze_resurfaced');
      expect(resurfaced.snooze_until).toBeNull();
    });
  });

  describe('Triage Statistics', () => {
    it('calculates lane distributions, avoided interruptions, and overrides', async () => {
      // Generate some notifications
      const simRes = await app.request(
        '/v1/simulate',
        {
          method: 'POST',
          headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: 'workday', count: 6 }),
        },
        env
      );
      expect(simRes.status).toBe(200);

      // Fetch stats
      const statsRes = await app.request(
        '/v1/stats?window=24h',
        { method: 'GET', headers: { 'X-Client-Id': clientId } },
        env
      );
      expect(statsRes.status).toBe(200);
      const stats = await statsRes.json();
      expect(stats.total).toBe(6);
      expect(stats.lanes.now).toBeGreaterThanOrEqual(1);
      expect(stats.interruptions_avoided_pct).toBeGreaterThan(0);
      expect(stats.classifier_mix.heuristic).toBe(6);
    });
  });

  describe('Simulator Scenarios', () => {
    it('generates realistic notifications for all scenarios', async () => {
      for (const scenario of ['workday', 'weekend', 'launch_day'] as const) {
        const simRes = await app.request(
          '/v1/simulate',
          {
            method: 'POST',
            headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
            body: JSON.stringify({ scenario, count: 4 }),
          },
          env
        );

        expect(simRes.status).toBe(200);
        const json = await simRes.json();
        expect(json.scenario).toBe(scenario);
        expect(json.count).toBe(4);
        expect(json.notifications.length).toBe(4);
      }
    });
  });
});
