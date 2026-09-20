// worker/src/simulator.ts
// Realistic scenario notification generator for demo and evaluation

import { NotificationPayload } from './types';

export type ScenarioType = 'workday' | 'weekend' | 'launch_day';

interface ScenarioTemplate {
  source: { domain: string; app?: string };
  sender?: string;
  title: string;
  body: string;
}

const WORKDAY_TEMPLATES: ScenarioTemplate[] = [
  {
    source: { domain: 'slack.com', app: 'Slack' },
    sender: 'alex',
    title: 'Alex mentioned you in #backend-team',
    body: 'Could you review the database migration PR before today standup?',
  },
  {
    source: { domain: 'calendar.google.com', app: 'Google Calendar' },
    title: 'Meeting in 10 min: Sprint Planning',
    body: 'Join Google Meet: https://meet.google.com/abc-defg-hij',
  },
  {
    source: { domain: 'github.com', app: 'GitHub' },
    sender: 'ci-bot',
    title: 'Deploy failed: main branch build #1489',
    body: 'Integration tests failed in test/payment.spec.ts',
  },
  {
    source: { domain: 'github.com', app: 'GitHub' },
    sender: 'sarah',
    title: 'Sarah requested your review on PR #312',
    body: 'Refactor notification pipeline to use Hono router',
  },
  {
    source: { domain: 'auth0.com', app: 'Auth0' },
    title: 'Your verification code is 849201',
    body: 'Enter code 849201 to complete your workstation login. Expires in 5 minutes.',
  },
  {
    source: { domain: 'marketing-hub.com' },
    title: 'Flash Sale: 40% off Developer Subscriptions',
    body: 'Upgrade your team cloud storage today with special coupon code SAVE40.',
  },
  {
    source: { domain: 'linear.app', app: 'Linear' },
    sender: 'product-lead',
    title: 'ENG-204 marked as Done',
    body: 'Notification batching endpoint verified in staging.',
  },
  {
    source: { domain: 'twitter.com' },
    title: 'Trending tech updates for you',
    body: 'Check out the top discussions in JavaScript and Cloudflare Workers.',
  },
];

const WEEKEND_TEMPLATES: ScenarioTemplate[] = [
  {
    source: { domain: 'netflix.com' },
    title: 'New Season available now',
    body: 'Continue watching your favorite sci-fi thriller series.',
  },
  {
    source: { domain: 'retailer.com' },
    title: 'Weekend Deal: 50% off all Electronics',
    body: 'Limited stock remaining! Shop the weekend flash sale.',
  },
  {
    source: { domain: 'linkedin.com' },
    title: 'Jane Doe and 4 others liked your post',
    body: 'See all reactions and views on your recent engineering article.',
  },
  {
    source: { domain: 'datadog.com', app: 'Datadog' },
    title: 'Security Alert: Unauthorized access attempt',
    body: 'Excessive failed SSH logins detected on worker-node-04.',
  },
  {
    source: { domain: 'spotify.com' },
    title: 'Your Discover Weekly is ready',
    body: '30 fresh tracks curated for your weekend listening.',
  },
  {
    source: { domain: 'medium.com' },
    title: 'The Daily Digest: 5 top stories in AI',
    body: 'Read how System One architectures are transforming low-latency inference.',
  },
];

const LAUNCH_DAY_TEMPLATES: ScenarioTemplate[] = [
  {
    source: { domain: 'pagerduty.com', app: 'PagerDuty' },
    title: 'CRITICAL P0: High 5xx error rate on api/checkout',
    body: 'Error rate spiked to 14.8%. On-call engineer alerted immediately.',
  },
  {
    source: { domain: 'stripe.com', app: 'Stripe' },
    title: 'Payment Succeeded: $5,000.00',
    body: 'Enterprise customer Acme Corp upgraded to Annual Tier.',
  },
  {
    source: { domain: 'slack.com', app: 'Slack' },
    sender: 'ceo',
    title: 'CEO sent you a direct message',
    body: 'Incredible launch today team! Traffic is 3x our original projections.',
  },
  {
    source: { domain: 'news.ycombinator.com' },
    title: 'Show HN: Hush AI Notification Triage reached #1',
    body: 'Over 120 comments posted in the last 45 minutes.',
  },
  {
    source: { domain: 'intercom.com', app: 'Intercom' },
    sender: 'vip-client',
    title: 'VIP Support Ticket: Urgent question about SSO setup',
    body: 'We are onboarding 500 team members right now, need guidance on SAML config.',
  },
  {
    source: { domain: 'cloudflare.com', app: 'Cloudflare' },
    title: 'Workers AI traffic limit approaching 80%',
    body: 'Consider adjusting concurrency settings or enabling tiered caching.',
  },
];

export function generateScenarioNotifications(scenario: ScenarioType, count?: number): NotificationPayload[] {
  let pool: ScenarioTemplate[];
  switch (scenario) {
    case 'weekend':
      pool = WEEKEND_TEMPLATES;
      break;
    case 'launch_day':
      pool = LAUNCH_DAY_TEMPLATES;
      break;
    case 'workday':
    default:
      pool = WORKDAY_TEMPLATES;
      break;
  }

  const requestedCount = count && count > 0 ? count : pool.length;
  const items: NotificationPayload[] = [];
  const baseTime = Date.now();

  for (let i = 0; i < requestedCount; i++) {
    const template = pool[i % pool.length];
    // Slightly offset timestamps
    const receivedAt = new Date(baseTime - (requestedCount - i) * 60 * 1000).toISOString();

    items.push({
      source: template.source,
      sender: template.sender,
      title: template.title,
      body: template.body,
      received_at: receivedAt,
    });
  }

  return items;
}
