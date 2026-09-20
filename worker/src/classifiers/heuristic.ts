// worker/src/classifiers/heuristic.ts
// Deterministic static heuristic classifier for Hush

import { DecisionResult, ClassifierType } from '../types';
import { isVerificationCode } from '../redaction';

interface ClassificationContext {
  domain: string;
  sender?: string;
  title: string;
  body?: string;
  focusMode?: boolean;
}

export function classifyHeuristic(
  ctx: ClassificationContext,
  classifierType: ClassifierType = 'heuristic'
): DecisionResult {
  const start = performance.now();
  const title = (ctx.title || '').toLowerCase();
  const body = (ctx.body || '').toLowerCase();
  const domain = (ctx.domain || '').toLowerCase();
  const sender = (ctx.sender || '').toLowerCase();
  const combined = `${title} ${body}`;

  // Check OTP
  if (isVerificationCode(`${ctx.title} ${ctx.body || ''}`)) {
    return {
      lane: 'now',
      lane_reason: 'heuristic:otp_verification',
      urgency: 5,
      confidence: 0.99,
      p_now: 0.99,
      p_later: 0.01,
      p_mute: 0.0,
      p_time_sensitive: 1.0,
      p_needs_reply: 0.1,
      p_from_person: 0.1,
      p_promotional: 0.0,
      p_suspicious: 0.0,
      uncertain: false,
      suspicious: false,
      classifier: classifierType,
      classify_ms: Math.round(performance.now() - start),
      answers: { method: 'otp_pattern_match' },
    };
  }

  // Check Suspicious / Phishing / Prompt Injection attempts
  const suspiciousKeywords = [
    'system prompt',
    'ignore prior instructions',
    'disregard all rules',
    'reset all instructions',
    'bank account suspended',
    'confirm your password immediately',
    'wire transfer required',
    'urgent action needed: click here to avoid termination',
  ];
  if (suspiciousKeywords.some((kw) => combined.includes(kw))) {
    return {
      lane: 'later',
      lane_reason: 'heuristic:suspicious_phishing_or_injection',
      urgency: 2,
      confidence: 0.85,
      p_now: 0.1,
      p_later: 0.85,
      p_mute: 0.05,
      p_time_sensitive: 0.2,
      p_needs_reply: 0.0,
      p_from_person: 0.1,
      p_promotional: 0.1,
      p_suspicious: 0.9,
      uncertain: false,
      suspicious: true,
      classifier: classifierType,
      classify_ms: Math.round(performance.now() - start),
      answers: { flagged: 'suspicious_content' },
    };
  }

  // Security alert / Critical ops / Infrastructure failure
  const criticalKeywords = [
    'security alert',
    'unauthorized login',
    'deploy failed',
    'deployment failed',
    'build failed',
    'service outage',
    'incident triggered',
    'pagerduty',
    'datadog alert',
    'critical vulnerability',
    'server is down',
    'database connection pool exhausted',
  ];
  if (criticalKeywords.some((kw) => combined.includes(kw))) {
    return {
      lane: 'now',
      lane_reason: 'heuristic:security_or_critical_alert',
      urgency: 5,
      confidence: 0.95,
      p_now: 0.95,
      p_later: 0.05,
      p_mute: 0.0,
      p_time_sensitive: 0.9,
      p_needs_reply: 0.4,
      p_from_person: 0.2,
      p_promotional: 0.0,
      p_suspicious: 0.05,
      uncertain: false,
      suspicious: false,
      classifier: classifierType,
      classify_ms: Math.round(performance.now() - start),
    };
  }

  // Imminent calendar / meeting
  const calendarKeywords = [
    'meeting starts in',
    'starts in 5 min',
    'starts in 10 min',
    'join now',
    'meeting now',
    'google meet is starting',
    'zoom meeting starting',
    'huddle started',
  ];
  if (calendarKeywords.some((kw) => combined.includes(kw))) {
    return {
      lane: 'now',
      lane_reason: 'heuristic:imminent_meeting',
      urgency: 4,
      confidence: 0.92,
      p_now: 0.92,
      p_later: 0.08,
      p_mute: 0.0,
      p_time_sensitive: 0.95,
      p_needs_reply: 0.5,
      p_from_person: 0.7,
      p_promotional: 0.0,
      p_suspicious: 0.0,
      uncertain: false,
      suspicious: false,
      classifier: classifierType,
      classify_ms: Math.round(performance.now() - start),
    };
  }

  // Promotional / Marketing / Engagement bait
  const promoKeywords = [
    '% off',
    'discount code',
    'limited time offer',
    'flash sale',
    'black friday',
    'special deal',
    'newsletter',
    'unroll.me',
    'weekly digest',
    'liked your post',
    'liked your photo',
    'followed you',
    'retweeted',
    'check out who viewed your profile',
    'new recommendations for you',
    'trending today',
  ];
  if (promoKeywords.some((kw) => combined.includes(kw))) {
    return {
      lane: 'mute',
      lane_reason: 'heuristic:promotional_or_engagement_bait',
      urgency: 1,
      confidence: 0.9,
      p_now: 0.05,
      p_later: 0.1,
      p_mute: 0.85,
      p_time_sensitive: 0.1,
      p_needs_reply: 0.05,
      p_from_person: 0.15,
      p_promotional: 0.95,
      p_suspicious: 0.0,
      uncertain: false,
      suspicious: false,
      classifier: classifierType,
      classify_ms: Math.round(performance.now() - start),
    };
  }

  // Direct mention or message from a person
  const isDirectMessage =
    Boolean(sender) ||
    combined.includes('mentioned you') ||
    combined.includes('sent you a message') ||
    combined.includes('direct message') ||
    domain.includes('slack') ||
    domain.includes('discord') ||
    domain.includes('teams') ||
    domain.includes('telegram') ||
    domain.includes('whatsapp');

  if (isDirectMessage) {
    const isFocus = Boolean(ctx.focusMode);
    // In focus mode, person messages wait for later unless high urgency
    const lane = isFocus ? 'later' : 'now';
    return {
      lane,
      lane_reason: isFocus ? 'heuristic:direct_message_deferred_focus_mode' : 'heuristic:direct_message_from_person',
      urgency: 3,
      confidence: 0.78,
      p_now: isFocus ? 0.35 : 0.75,
      p_later: isFocus ? 0.6 : 0.2,
      p_mute: 0.05,
      p_time_sensitive: 0.65,
      p_needs_reply: 0.75,
      p_from_person: 0.85,
      p_promotional: 0.05,
      p_suspicious: 0.0,
      uncertain: false,
      suspicious: false,
      classifier: classifierType,
      classify_ms: Math.round(performance.now() - start),
    };
  }

  // General batchable update (GitHub PR reviews, CI passing, Jira ticket updates)
  const devWorkKeywords = ['pull request', 'pr #', 'assigned you', 'jira', 'linear issue', 'build succeeded', 'commit'];
  if (devWorkKeywords.some((kw) => combined.includes(kw))) {
    return {
      lane: 'later',
      lane_reason: 'heuristic:developer_workflow_update',
      urgency: 2,
      confidence: 0.8,
      p_now: 0.2,
      p_later: 0.75,
      p_mute: 0.05,
      p_time_sensitive: 0.4,
      p_needs_reply: 0.3,
      p_from_person: 0.6,
      p_promotional: 0.0,
      p_suspicious: 0.0,
      uncertain: false,
      suspicious: false,
      classifier: classifierType,
      classify_ms: Math.round(performance.now() - start),
    };
  }

  // Default neutral fallback
  return {
    lane: 'later',
    lane_reason: 'heuristic:default_batch_later',
    urgency: 2,
    confidence: 0.55,
    p_now: 0.25,
    p_later: 0.55,
    p_mute: 0.2,
    p_time_sensitive: 0.3,
    p_needs_reply: 0.2,
    p_from_person: 0.4,
    p_promotional: 0.2,
    p_suspicious: 0.0,
    uncertain: true,
    suspicious: false,
    classifier: classifierType,
    classify_ms: Math.round(performance.now() - start),
  };
}
