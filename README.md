# Hush: AI Notification Triage

Intelligent notification manager and triage agent sitting between web notifications and the user (Chrome extension + Cloudflare backend).

Hush sits between web notifications and the user. For each incoming notification, Jev (TypeSafe AI's "System One" model) decides in one fast, parallel call whether it should interrupt now, wait for a digest ("later"), or be muted. Llama on Workers AI handles anything that needs language: drafting short replies and writing digests.

## Features

- **Fast parallel classification**: Uses TypeSafe AI's "System One" model (Jev) to assess urgency, time sensitivity, conversational need, and lane placement (`now`, `later`, `mute`) in a single fast call.
- **Language generation**: Uses Workers AI (Llama) for drafting context-aware quick responses and periodic digests.
- **Deterministic routing**: User rules, verification code bypass, and threshold-based decision engine.
- **Privacy & Safety**: Client-side redaction before payloads leave the device, deterministic rule enforcement, and fail-open guarantees.

## Architecture

- **Extension**: Chrome Manifest V3 extension with MAIN-world interception hook, isolated-world bridge, and side panel UI.
- **Backend**: Cloudflare Workers with D1 SQL storage, Workers AI, Workflows, and Cron Triggers.
