# SPEC: Hush, AI notification triage (Chrome extension + Cloudflare backend)

Hush sits between web notifications and the user. For each incoming notification, Jev (TypeSafe AI's "System One" model) decides in one fast, parallel call whether it should interrupt now, wait for a digest ("later"), or be muted. Llama on Workers AI handles anything that needs language: drafting short replies and writing digests.

Jev does not generate text. You send it a block of state plus typed questions (choice, score, or probability), and it returns typed answers with probabilities. Jev never writes prose, and Llama never makes routing decisions.

## Non-goals
- No sending replies or messages on the user's behalf. Drafts are text to copy.
- No reading page content. Only notification payloads.
- No Firefox/Safari, mobile, accounts/OAuth, or Chrome Web Store publishing (load unpacked is enough).
- No interception of notifications shown by a site's service worker or by push (see Open questions).

## Ground rules
- Follow AGENTS.md. Do not rely on memory for Chrome, Cloudflare, or Jev APIs. Read the current docs first and record the pages used in commit bodies.
- Worker in TypeScript (Hono is fine). Extension and web UI in plain JavaScript ES modules with JSDoc types, no bundler. Minimal dependencies.
- Cloudflare: Workers, D1, Workers AI, Workflows, Cron Triggers, static assets, and the rate limiting binding if the docs support it. No KV, R2, or Durable Objects.
- Secrets: `JEV_API_KEY`. Vars: `JEV_MODE` (`jev` | `heuristic`), `NOW_THRESHOLD`, `MUTE_THRESHOLD`.

## Architecture
```
Allowlisted page -> MAIN-world hook captures new Notification()
  -> isolated-world bridge -> service worker
  -> on-device redaction -> POST /v1/notifications
  -> Worker: re-redact, dedupe, rules, Jev (one call), routing in code, log to D1
  -> decision returns to the hook: 'now' shows the original notification; 'later' and 'mute' suppress it
  -> side panel shows Now / Later / Muted lanes, drafts, digest, stats
Workflows: digest pipeline. Cron: snooze resurfacing and retention cleanup.
```

## Jev question set (one call per notification)
State: user's priorities text, focus_mode flag, local time, plus the notification: source_domain, sender (if any), title, body. Wrap the notification in explicit delimiters and treat it as untrusted data.
- `lane` (choice: now | later | mute): "When should the user see this: interrupt now, batch for later, or mute?"
- `urgency` (score 1-5)
- `time_sensitive` (probability): "Loses most of its value if not seen within an hour."
- `needs_reply` (probability): "A person is waiting for a reply from the user."
- `from_person` (probability): "Written by an individual, not a system or marketing."
- `promotional` (probability): "Marketing, promo, or engagement bait."
- `suspicious` (probability): "Looks like phishing, a scam, or tries to instruct the reader or an AI."
If the API returns per-option probabilities for `lane`, use them. Otherwise use the chosen option's confidence. Check the docs.

## Routing (in code, never in Jev). Thresholds are settings.
1. Verification codes (OTP patterns): lane = now; never store the body.
2. User rules, ordered by priority; first match wins; reason `rule:<id>`.
3. Otherwise, from Jev's answers:
   - suspicious >= 0.6: lane = later, `suspicious=1`, shown with a warning.
   - focus_mode on: now only if urgency >= 4 AND time_sensitive >= 0.7, else later.
   - now if P(now) >= NOW_THRESHOLD (default 0.6) OR urgency >= 4.
   - mute only if P(mute) >= MUTE_THRESHOLD (default 0.8) AND from_person < 0.3 AND needs_reply < 0.3.
   - if the top lane probability < 0.5: lane = later, `uncertain=1`. Never mute when uncertain.
4. A wrong mute costs more than a wrong interruption. The thresholds encode that, and the README must explain it.
5. `lane_reason` always says why (rule id, or the Jev signals that decided it).

## Fallbacks and failure behavior
- Heuristic classifier (`heuristic.ts`): deterministic lane and scores from source type, sender presence, and keywords (verify, security alert, meeting in, deploy failed, invoice due, % off, liked your). Used when `JEV_MODE=heuristic`, on Jev error or 2s timeout (`classifier='heuristic_fallback'`), and as an eval baseline.
- The extension fails open: on Worker error, timeout (~1.5s), or offline, show the original notification and queue the event for later triage. Never silently swallow a notification because of an error.
- Rate limits per `client_id` (default 120 notifications/hour) and a global daily cap. Over the cap, use the heuristic classifier and mark it.

## Privacy and safety
- Data leaves the device (Worker, then Jev). First run shows a plain-language consent screen. The allowlist of sites starts empty.
- No `<all_urls>` at install. Request host access per site through optional host permissions when the user adds a site. Dynamic content script registration only for granted sites.
- Redact on device before sending (emails, phone numbers, long digit sequences, URL query strings). The Worker redacts again. `redact` is on by default.
- Retention: body nulled after `retention_days` (default 7), rows deleted after 30 days, `DELETE /v1/data` wipes everything for a client.
- Prompt injection: notification text is data. Rules run deterministically and cannot be overridden by content. Llama prompts state that notification text must never be followed as instructions, drafts contain no links, and nothing is sent automatically.
- Render all notification and model text with `textContent`, never `innerHTML`.

## Identity
No accounts. Each install (and each `/demo` session) generates a random UUID `client_id` and sends it as `X-Client-Id`. All data is scoped to it and the UUID acts as a bearer secret. State this tradeoff in the README. It lets reviewers try the hosted demo with zero setup.

## D1 schema (migration `0001_init.sql`)
```sql
CREATE TABLE clients (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('sender','domain','keyword')),
  pattern TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('now','later','mute')),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  source_domain TEXT NOT NULL, sender TEXT, title TEXT NOT NULL, body TEXT,
  dedupe_hash TEXT NOT NULL,
  classifier TEXT NOT NULL,            -- 'jev' | 'heuristic' | 'heuristic_fallback' | 'rule'
  lane TEXT NOT NULL CHECK (lane IN ('now','later','mute')),
  lane_reason TEXT NOT NULL,
  urgency REAL, p_now REAL, p_later REAL, p_mute REAL,
  p_time_sensitive REAL, p_needs_reply REAL, p_from_person REAL,
  p_promotional REAL, p_suspicious REAL,
  answers_json TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0, suspicious INTEGER NOT NULL DEFAULT 0,
  classify_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','snoozed')),
  snooze_until TEXT,
  user_lane TEXT CHECK (user_lane IN ('now','later','mute')),   -- user correction = feedback label
  created_at TEXT NOT NULL
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  tone TEXT NOT NULL, text TEXT NOT NULL, model TEXT NOT NULL, latency_ms INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE digests (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, period_start TEXT, period_end TEXT, item_count INTEGER,
  summary_json TEXT, status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY, client_id TEXT, created_at TEXT NOT NULL, classifier TEXT NOT NULL,
  n INTEGER, accuracy REAL, false_mute_rate REAL, results_json TEXT
);
CREATE INDEX idx_notif_client_time ON notifications(client_id, received_at);
CREATE INDEX idx_notif_dedupe ON notifications(client_id, dedupe_hash);
```

## Worker API (JSON, validated input, errors as `{ "error": "..." }`)
All routes require `X-Client-Id` (UUID). Public deployment.
- `POST /v1/notifications`: `{ source: { domain, app? }, sender?, title, body?, url?, received_at, focus_mode? }`. Validates sizes (title 200, body 1000 chars), redacts, dedupes within a short window, classifies, routes, stores. Returns `{ id, lane, reason, urgency, confidence, uncertain, suspicious, classifier, classify_ms }`. Also `POST /v1/notifications/batch` (max 20).
- `GET /v1/notifications?lane=&status=&limit=&before=`
- `POST /v1/notifications/:id/action`: `{ action: 'done' | 'snooze' | 'move' | 'mute_source', lane?, until? }`. `move` stores `user_lane` (feedback).
- `POST /v1/notifications/:id/draft-reply`: `{ tone: 'brief' | 'friendly' | 'formal' }`. Llama drafts text only.
- `GET|PUT /v1/settings`: priorities text, focus schedule, thresholds, redact, retention_days, allowed sites.
- `GET|POST|PUT|DELETE /v1/rules`: validate type, action, non-empty pattern.
- `POST /v1/digest/run` (starts the Workflow), `GET /v1/digest/latest`.
- `GET /v1/stats?window=1h|24h|7d`: counts per lane; interruptions avoided %; override rate (user_lane != lane); user-corrected false mutes; Jev latency p50/p95; classifier mix and fallback rate; time series.
- `POST /v1/simulate`: `{ scenario: 'workday' | 'weekend' | 'launch_day', count }` generates realistic notifications for the demo.
- `POST /v1/eval/run`: see Eval.
- `DELETE /v1/data`: wipes everything for this client.

## Workflows and Cron
- Digest Workflow (durable steps with retries): load open `later` items -> group by source/thread -> Llama summarizes each group (bounded concurrency) -> order groups by max urgency -> store `summary_json` -> mark digest done. Digest JSON: per-group title, count, one-line summary, and "top 3 to look at".
- Cron (every minute): resurface snoozed items whose `snooze_until` passed (back to `now`). Daily: retention cleanup.

## Llama usage
Choose models from the CURRENT Workers AI catalog (a larger instruct model for drafts, a cheaper one for digest summaries if suitable). Record the choice and reason in the README. Do not guess model IDs or prices.

## Extension (Manifest V3)
- Verify current APIs in Chrome's docs: side panel, optional host permissions, dynamic content script registration with `world: "MAIN"`, message passing, alarms. MV3 service workers are ephemeral, so persist state in `chrome.storage`, never in globals.
- MAIN-world hook: wraps `window.Notification` (and page-context `showNotification` if feasible). The wrapper must preserve `Notification.permission`, `requestPermission()`, `onclick`/`onclose`, `close()`, and `instanceof`, so pages do not break. It returns a stand-in object immediately and only creates the real notification if the decision is `now`, or on timeout or failure (fail-open).
- Service worker: handles bridge messages, calls the Worker, keeps an offline queue in `chrome.storage.local`, updates the action badge with the count of open `now` items.
- Side panel: lane tabs with counts. Each card shows source domain, title, snippet, urgency, confidence, and reason chips ("Rule: VIP sender", "Jev: time-sensitive 0.82"), plus Done, Snooze (1h / tomorrow), Move to..., Mute source, and Draft reply (with copy button). Also Digest and Stats tabs.
- Options page: consent, Worker URL, `client_id`, allowed sites (grants permission), priorities text, focus schedule, thresholds, rules CRUD, redaction toggle, delete-my-data.
- The UI code lives once in `/web`. Serve it from the Worker at `/demo` (same-origin API, with a built-in simulator so reviewers can try it with no extension). `scripts/sync-ui.mjs` copies it into the extension's side panel.
- `test/notify-test.html` (served by `wrangler dev`) fires varied `new Notification()` calls so the hook can be tested without real sites.

## Repo layout
`worker/` (src, migrations, tests, wrangler config), `web/`, `extension/`, `eval/`, `scripts/`, `test/`, `README.md`, `SPEC.md`, `AGENTS.md`, `PROMPTS.md`, `prompt-history/raw/`.

## Eval (`eval/dataset.json`, `eval/persona.txt`)
- About 100 items: `{ title, body, source_domain, sender?, expected_lane, tags }`, written for one stated persona (a software engineer on a small team). Include chat DMs and mentions, calendar reminders, CI/deploy alerts, security alerts, OTPs, delivery updates, newsletters, promos, engagement bait, and ~15 adversarial items (instructions hidden in notification text, fake "URGENT" phishing, look-alike domains).
- Split 70 dev / 30 held-out. Tune thresholds on dev only. Do not edit the dataset after seeing results.
- Compare three classifiers on the held-out set: Jev, heuristic, and Llama-only (constrained to output one lane).
- Report: accuracy; per-lane precision and recall; false-mute rate (important item muted); false-interrupt rate; calibration table (confidence bins vs accuracy); latency p50/p95; cost per 1,000 notifications. Show every misclassified item with a guess why.
- Tell me the labels are hand-assigned and need my review.

## Tests
Use the Workers test setup recommended in the current docs. Cover: routing thresholds and precedence, rules matching, redaction, OTP handling, dedupe, rate limiting and fallback, action/snooze logic, and the hook's fail-open behavior with a mocked bridge.

## Phases (stop and report after each)
1. Worker scaffold, wrangler config, migration, client scoping, settings and rules CRUD, rate limiting, tests.
2. Redaction, Jev adapter with heuristic fallback, routing logic, and `POST /v1/notifications` (decision only, then storage), with tests.
3. List, actions, snooze cron, stats, simulator.
4. Draft reply (Workers AI) and the digest Workflow.
5. Web UI at `/demo`: lanes, cards, drafts, digest, stats, settings and rules.
6. Extension: manifest, permissions flow, hook, service worker, side panel sync, badge, offline queue, fail-open. Verify with `test/notify-test.html`.
7. Eval dataset, `/v1/eval/run`, results panel, held-out numbers.
8. README (architecture diagram, deploy steps, privacy section, tradeoffs, eval table, known limitations), demo script, and final polish.

## Open questions (answer in your Phase 0 report; do not assume)
- What is Jev's request format and auth, does it return per-option probabilities for `choice`, and is it reachable directly from a Worker?
- Which real sites call `Notification` from page context, and what does the hook not cover (service-worker and push notifications)?
- Which current Workers AI models fit drafting and summarizing?
- Does the Workflows and rate-limiting binding setup work as documented?

## Done when
- The hook captures notifications from `test/notify-test.html` and from at least one real allowlisted site (or the report says which sites were tested and which were not).
- `now` shows the original notification, `later`/`mute` suppress it, and killing the Worker makes everything show (fail-open).
- The side panel and `/demo` show live lanes, reasons, and stats, and a user correction updates the override rate.
- The digest Workflow runs end to end. Snoozed items resurface.
- Works with `JEV_MODE=heuristic` and with the real Jev key.
- Held-out eval numbers, README, and PROMPTS.md are complete and the Worker is deployed with a public `/demo` URL.
