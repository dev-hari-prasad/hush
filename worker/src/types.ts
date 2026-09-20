// worker/src/types.ts

export type Lane = 'now' | 'later' | 'mute';
export type ClassifierType = 'jev' | 'heuristic' | 'heuristic_fallback' | 'rule';
export type NotificationStatus = 'open' | 'done' | 'snoozed';
export type RuleType = 'sender' | 'domain' | 'keyword';
export type ActionType = 'done' | 'snooze' | 'move' | 'mute_source';

export interface ClientSettings {
  priorities_text: string;
  focus_mode: boolean;
  focus_schedule: {
    enabled: boolean;
    start: string; // "09:00"
    end: string;   // "17:00"
    days: number[]; // 1 = Monday, 7 = Sunday
  };
  now_threshold: number; // default 0.6
  mute_threshold: number; // default 0.8
  redact: boolean; // default true
  retention_days: number; // default 7
  allowed_sites: string[];
  jev_endpoint: string; // default "https://api.typesafe.ai/v1/systemone"
  jev_api_key?: string;
  llm_base_url: string; // default "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1"
  llm_api_key?: string;
  llm_model: string; // default "@cf/meta/llama-3.1-8b-instruct"
}

export interface Rule {
  id: string;
  client_id: string;
  type: RuleType;
  pattern: string;
  action: Lane;
  priority: number;
  enabled: number; // 0 or 1
  created_at: string;
}

export interface NotificationPayload {
  source: {
    domain: string;
    app?: string;
  };
  sender?: string;
  title: string;
  body?: string;
  url?: string;
  received_at?: string;
  focus_mode?: boolean;
}

export interface NotificationRecord {
  id: string;
  client_id: string;
  received_at: string;
  source_domain: string;
  sender: string | null;
  title: string;
  body: string | null;
  dedupe_hash: string;
  classifier: ClassifierType;
  lane: Lane;
  lane_reason: string;
  urgency: number | null;
  p_now: number | null;
  p_later: number | null;
  p_mute: number | null;
  p_time_sensitive: number | null;
  p_needs_reply: number | null;
  p_from_person: number | null;
  p_promotional: number | null;
  p_suspicious: number | null;
  answers_json: string | null;
  uncertain: number;
  suspicious: number;
  classify_ms: number | null;
  status: NotificationStatus;
  snooze_until: string | null;
  user_lane: Lane | null;
  created_at: string;
}

export interface DecisionResult {
  lane: Lane;
  lane_reason: string;
  urgency: number;
  confidence: number;
  p_now: number;
  p_later: number;
  p_mute: number;
  p_time_sensitive: number;
  p_needs_reply: number;
  p_from_person: number;
  p_promotional: number;
  p_suspicious: number;
  uncertain: boolean;
  suspicious: boolean;
  classifier: ClassifierType;
  classify_ms: number;
  answers?: Record<string, unknown>;
}

export interface DraftRecord {
  id: string;
  notification_id: string;
  tone: 'brief' | 'friendly' | 'formal';
  text: string;
  model: string;
  latency_ms: number;
  created_at: string;
}

export interface DigestRecord {
  id: string;
  client_id: string;
  created_at: string;
  period_start: string | null;
  period_end: string | null;
  item_count: number | null;
  summary_json: string | null;
  status: 'pending' | 'completed' | 'failed';
}

export interface Env {
  DB: D1Database;
  AI?: unknown;
  DIGEST_WORKFLOW?: unknown;
  RATE_LIMITER?: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };
  ASSETS?: Fetcher;
  JEV_API_KEY?: string;
  JEV_MODE?: string;
  NOW_THRESHOLD?: string;
  MUTE_THRESHOLD?: string;
}
