# Sonora — Text-to-Audio Studio

React/Vite and Node/Express streaming prototype based on the supplied SRS. Local transport tests pass; authenticated Gemini speech and browser listening tests remain pending.

## Run locally

1. Run `npm install`.
2. Create `.env` using `.env.example`. Set `GEMINI_API_KEY` locally. `GEMINI_DEFAULT_MODEL` defaults to `gemini-3.8-flash-tts`; choose a catalog model available to your account. Existing `GEMINI_LIVE_MODEL` settings take precedence for backward compatibility; remove that override if you want the new default. Never put a key in frontend code or chat.
3. Run `npm run dev`, then visit http://localhost:5173.
4. For a built local preview, run `npm run build` followed by `npm start` and visit http://localhost:8787.
5. Run `npm test` for local chunking, configuration, and WAV-header checks.

## SRS review and necessary clarifications

- The model shortlist below uses IDs from the user's screenshot, not a verified provider model inventory. Availability, supported voices, and generation parameters still need authenticated testing. All entries are marked unverified in the UI; there is no silent model substitution.
- The 1,000,000 limit is an application character limit (JavaScript UTF-16 code units), not a verified Gemini token or context limit. Tokens, characters, output duration, and service quotas are different constraints.
- The installed SDK accepts `sendRealtimeInput({ text })` but does not define `turn_complete` there. This prototype awaits server turn completion with a timeout; it does not fabricate an unsupported wire field. This routing requirement needs service-level verification before production.
- Close code 1008 is a policy violation, not inherently a transient disconnect. Blind reconnection can replay output and repeat authentication failures. This milestone fails closed rather than pretending to resume a session.
- The Live system instruction explicitly treats input as narration and forbids answering or reacting to it. Prompt compliance is not guaranteed by the model; provider-backed audio/transcript acceptance tests are still required.
- Angle brackets and pacing text are preserved, but provider interpretation as pacing controls is not guaranteed. Long tags can cross chunk boundaries.

## Implemented milestone

### Requested Live model catalog

| Model ID | Role | Transport | Application character cap |
| --- | --- | --- | ---: |
| `gemini-2.5-flash-native-audio-preview-12-2025` | Default native audio | Live | 1,000,000 |
| `gemini-3.8-live` | Advanced Live option | Live | 65,000 |
| `gemini-3.8-live-extended-thinking` | Extended reasoning Live option | Live | 65,000 |

These are conservative application caps, not claims of unlimited provider rates or quotas. Selecting an engine updates validation on both client and server. Backup selection is manual: failed requests are never automatically replayed on another model. The `gemini-3-flash-live`, `gemini-3.5-live-translate`, and `gemini-3.5-transcribe-live` entries were removed from the selectable catalog after the Live API rejected them as missing/unsupported models or rejected AUDIO output.

All catalog choices use the Live WebSocket path with AUDIO-only setup and sequential realtime text input. The immutable server instruction requires exact verbatim playback and forbids translation, transcription, and task execution. Model availability and audio-generation compatibility must still be verified against the configured Google account.

Responsive dark studio UI, server-reported model/configuration, full 30-name voice roster, explicit character counter, over-limit blocking, locked generation controls, backend-only API key, immutable server instruction, AUDIO-only Live setup, sequential bounded text chunks, multipart audio parsing, timeout/cancellation handling, PCM validation, progressive Web Audio playback, pause/resume, cancellation, and complete mono 24kHz 16-bit WAV playback/download.

The UI loads `/api/config` without exposing credentials and disables generation until server configuration is present. Configuration presence does not prove model access. Restart the server after changing `.env`, then use **Retry configuration** in the studio.

Guests have a server-enforced allowance of 50 submitted whitespace-separated words per IP per UTC day. Signing in with Google raises the active allowance to 1,000 words per Google account per UTC day. The account allowance is separate from the guest IP allowance; signing in switches to the account counter. All models share the same counter for that identity. Submitted text includes bracketed delivery tags, and accepted requests count even if synthesis later fails or is cancelled. PostgreSQL stores daily usage by subject type and HMAC hash, not raw IP address or Google account ID. Configure `DATABASE_URL` and a stable `DAILY_QUOTA_SECRET`. The server applies an idempotent schema migration on first database use. In local development without `DATABASE_URL`, it uses a volatile in-memory allowance and logs a warning; production fails closed if PostgreSQL is unavailable or not configured. Behind a reverse proxy, set `TRUST_PROXY` to only trusted proxy IPs/CIDRs so Express can identify clients; never trust arbitrary forwarded IP headers.

### Google sign-in setup

Create a Google OAuth client in Google Cloud Console with the OAuth consent screen configured and an authorized redirect URI exactly matching `https://sonora.rawse.in/auth/google/callback` (use your own production domain if it differs). Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` to the matching OAuth client values; the redirect URI must match exactly. Set a long, random `SESSION_SECRET`. Google sign-in is enabled only when all three `GOOGLE_*` values are present. The Render Blueprint prompts for the OAuth values and generates `SESSION_SECRET`; set `GOOGLE_REDIRECT_URI` to the production callback URL. PostgreSQL stores sessions across service instances. The server validates OAuth state and the Google ID token nonce and audience, and uses a secure, HTTP-only, same-site session cookie. Never commit OAuth secrets.

`POST /api/generate/stream` streams NDJSON `start`, `audio`, `progress`, `done` events. Failures after streaming starts produce `error`, never a successful partial WAV. The browser decodes PCM with explicit little-endian conversion and creates a 24000 Hz AudioContext from the Generate gesture. The older `/api/generate` completed-WAV endpoint remains available.

`test/stream.test.js` uses an injected test-only synthesizer to check real HTTP streaming before completion, validation, sanitized failures, configuration secrecy, origin restrictions, NDJSON boundaries, and PCM conversion. It does not claim to test Google's service or browser audio hardware.

## Remaining work

The browser receives progressive audio over streaming HTTP; only the backend uses the SDK Live WebSocket. Safe acknowledged session resumption, verified per-model voice compatibility and quota metadata, provider-backed tests, browser listening checks, and measured first-audio latency remain pending. Output has a 128 MiB guard and a ten-minute deadline; the browser also caps NDJSON transport at 128 MiB, so base64 overhead lowers its effective PCM maximum. The input cap does not promise a million-character generation will finish.

For local development, the server defaults to loopback, restricts browser origins to explicit local addresses, caps active synthesis at two requests, and aborts slow clients at a bounded stream buffer. The IP-based daily quota is not a reliable identity system: people sharing an IP share one allowance, and changing networks can bypass it. PostgreSQL coordinates quota usage across multiple backend instances. Authentication and HTTPS deployment are not implemented.

`render.yaml` provides a free-tier Render demo Blueprint. Create a new Blueprint from the repository and provide `GEMINI_API_KEY` when prompted. To enable Google sign-in, also provide `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`; use the production callback URL configured in Google Cloud. The Blueprint generates `SESSION_SECRET`. It provisions a free web service and free PostgreSQL database, builds with `npm ci && npm run build`, and starts with `npm start`. Render's `RENDER_EXTERNAL_URL` supplies the service origin automatically; set `PUBLIC_ORIGIN` to your custom-domain origin if you add one. It provisions a free PostgreSQL database; the free database is temporary and may expire/delete its data, so do not use it for durable quota history. The free web service may spin down while idle. The Blueprint trusts one Render proxy hop for IP-based quotas. Free tier and plan details can change; verify current limits in Render before deploying.

Guests can generate without an account up to the 50-word IP-based daily allowance; Google sign-in is optional. The IP quota is only a basic usage guard, not strong abuse protection. Avoid exposing a paid provider key without monitoring provider spend and configuring provider-side quotas. For persistent production use, switch to a non-expiring PostgreSQL plan and set the web service plan appropriate to expected usage.
