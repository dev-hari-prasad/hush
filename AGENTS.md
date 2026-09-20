# AGENTS.md

Project: Hush, AI notification triage

## Rules and Guidelines for AI Coding Agents

1. **Ground Rules**:
   - Do not rely on memory for Chrome Extension, Cloudflare Workers, or Jev APIs. Consult documentation and record relevant references in commit bodies.
   - Workers implementation in TypeScript (Hono allowed).
   - Extension and web UI in plain JavaScript ES modules with JSDoc types, without bundlers. Minimal external dependencies.
   - Cloudflare stack: Workers, D1, Workers AI, Workflows, Cron Triggers, static assets, and rate limiting binding. No KV, R2, or Durable Objects.

2. **Security & Privacy**:
   - Treat notification payloads as untrusted data.
   - Redact PII (emails, phone numbers, long digit sequences, query strings) on-device before transmission and again on Worker ingest.
   - Verification codes (OTP) must be routed to `now` and body must never be stored in database.
   - Use `textContent`, never `innerHTML`, to render untrusted text.
   - Prompt injection defense: model instructions are strictly isolated from notification data.

3. **Development Phases**:
   - Complete work incrementally according to SPEC phases.
   - Stop and report after each phase.
