// worker/src/classifiers/router.ts
// Deterministic routing engine implementing strict precedence and threshold logic

import { Rule, DecisionResult, Lane, ClientSettings } from '../types';
import { isVerificationCode } from '../redaction';

interface RoutingContext {
  domain: string;
  sender?: string;
  title: string;
  body?: string;
  focusMode: boolean;
  settings: ClientSettings;
  rules: Rule[];
  rawClassification: DecisionResult;
}

export function routeNotification(ctx: RoutingContext): DecisionResult {
  const { domain, sender, title, body, focusMode, settings, rules, rawClassification } = ctx;
  const combined = `${title} ${body || ''}`;

  // 1. Verification codes (OTP patterns)
  // Immediate 'now' bypass; body must never be stored.
  if (isVerificationCode(combined)) {
    return {
      ...rawClassification,
      lane: 'now',
      lane_reason: 'otp_verification',
      urgency: 5,
      confidence: 1.0,
      p_now: 1.0,
      p_later: 0.0,
      p_mute: 0.0,
      p_time_sensitive: 1.0,
      uncertain: false,
      suspicious: false,
    };
  }

  // 2. User rules, ordered by priority (first match wins)
  const normDomain = domain.toLowerCase();
  const normSender = (sender || '').toLowerCase();
  const normCombined = combined.toLowerCase();

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const pattern = rule.pattern.toLowerCase().trim();
    let matches = false;

    if (rule.type === 'domain') {
      matches = normDomain === pattern || normDomain.endsWith(`.${pattern}`) || normDomain.includes(pattern);
    } else if (rule.type === 'sender') {
      matches = normSender === pattern || normSender.includes(pattern);
    } else if (rule.type === 'keyword') {
      matches = normCombined.includes(pattern);
    }

    if (matches) {
      return {
        ...rawClassification,
        lane: rule.action,
        lane_reason: `rule:${rule.id}`,
        classifier: 'rule',
        confidence: 1.0,
      };
    }
  }

  // 3. Routing from classification answers & configured thresholds
  const nowThreshold = settings.now_threshold ?? 0.6;
  const muteThreshold = settings.mute_threshold ?? 0.8;
  const c = rawClassification;

  // Suspicious flag quarantine (suspicious >= 0.6: lane = later, suspicious = 1)
  if (c.p_suspicious >= 0.6 || c.suspicious) {
    return {
      ...c,
      lane: 'later',
      lane_reason: `${c.lane_reason}:suspicious_quarantine(p_suspicious=${c.p_suspicious.toFixed(2)})`,
      suspicious: true,
    };
  }

  // Focus mode override (now only if urgency >= 4 AND time_sensitive >= 0.7, else later)
  if (focusMode) {
    if (c.urgency >= 4 && c.p_time_sensitive >= 0.7) {
      return {
        ...c,
        lane: 'now',
        lane_reason: `${c.lane_reason}:focus_mode_exception(urgency=${c.urgency},time_sensitive=${c.p_time_sensitive.toFixed(2)})`,
      };
    } else {
      return {
        ...c,
        lane: 'later',
        lane_reason: `${c.lane_reason}:focus_mode_active(deferred)`,
      };
    }
  }

  // Top lane probability < 0.5: lane = later, uncertain = 1 (Never mute when uncertain)
  const maxLaneP = Math.max(c.p_now, c.p_later, c.p_mute);
  if (maxLaneP < 0.5) {
    return {
      ...c,
      lane: 'later',
      lane_reason: `${c.lane_reason}:uncertain_confidence(${maxLaneP.toFixed(2)})`,
      uncertain: true,
    };
  }

  // Now condition: P(now) >= NOW_THRESHOLD OR urgency >= 4
  if (c.p_now >= nowThreshold || c.urgency >= 4) {
    return {
      ...c,
      lane: 'now',
      lane_reason: `${c.lane_reason}:${c.p_now >= nowThreshold ? `p_now_${c.p_now.toFixed(2)}>=${nowThreshold}` : `urgency_${c.urgency}>=4`}`,
    };
  }

  // Mute condition: P(mute) >= MUTE_THRESHOLD AND from_person < 0.3 AND needs_reply < 0.3
  if (c.p_mute >= muteThreshold && c.p_from_person < 0.3 && c.p_needs_reply < 0.3) {
    return {
      ...c,
      lane: 'mute',
      lane_reason: `${c.lane_reason}:p_mute_${c.p_mute.toFixed(2)}>=${muteThreshold}_low_personal`,
    };
  }

  // Fallback: batch for later
  return {
    ...c,
    lane: 'later',
    lane_reason: `${c.lane_reason}:batch_later(p_later=${c.p_later.toFixed(2)})`,
  };
}
