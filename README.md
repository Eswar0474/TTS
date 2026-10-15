# Sonora — Text-to-Audio Studio

React/Vite and Node/Express streaming prototype based on the supplied SRS. Local transport tests pass; authenticated Gemini speech and browser listening tests remain pending.

## Run locally

1. Run `npm install`.
2. Create `.env` using `.env.example`. Set `GEMINI_API_KEY` locally. `GEMINI_DEFAULT_MODEL` defaults to `gemini-3.8-flash-tts`; choose a catalog model available to your account. Existing `GEMINI_LIVE_MODEL` settings take precedence for backward compatibility; remove that override if you want the new default. Never put a key in frontend code or chat.
3. Run `npm run dev`, then visit http://localhost:5173.
4. For a built local preview, run `npm run build` followed by `npm start` and visit http://localhost:8787.
5. Run `npm test` for local chunking, configuration, and WAV-header checks.

During `npm run dev`, Vite proxies `/api`, `/auth`, `/how-it-works`, `/robots.txt`, and `/sitemap.xml` to the Express server. Therefore `http://localhost:5173/how-it-works` opens the standalone guide page instead of the React studio fallback. A production-style `npm start` serves the same canonical route directly.

## Security boundaries

- Production Express responses send CSP, `nosniff`, frame, referrer, permissions, same-origin resource, and HSTS headers. Google Fonts are not loaded from a third party; the UI uses local/system fallbacks.
- The server accepts only configured public Host values in production (`SITE_URL`, `PUBLIC_ORIGIN`/`PUBLIC_ORIGINS`, and Render's `RENDER_EXTERNAL_URL`). Localhost/loopback Hosts are allowed only outside production. CORS is an origin check, not authentication.
- Guest generation remains intentionally available, but each quota subject also has a short-window, per-process request budget and the existing daily word budget. For multiple instances, add equivalent edge/provider rate limits; keep the service behind HTTPS and do not expose a provider key from frontend code.
- PostgreSQL queries use fixed SQL with bound parameters. Production database pools reject explicitly non-TLS URI modes and enable certificate-checked TLS; provide `DATABASE_SSL_CA` when a private certificate authority is required. Storage-provider encryption at rest remains a hosting/database responsibility.
- Scripts are sent to Gemini for synthesis but are not stored as raw text in the quota tables. Quota identifiers are HMAC-hashed, and operational errors omit raw database/provider messages, script text, credentials, and connection details from logs. Provider retention is controlled by Google's service/account policy and is not something this proxy can erase.
- Audio and stream limits are separate: PCM has a 128 MiB limit and NDJSON has a larger base64-aware wire limit. Base64 is validated linearly, and whitespace-only chunks are never sent as provider turns.

## Google Search indexing and submission

The public homepage includes a descriptive title, description, canonical URL, social metadata, WebSite/WebApplication JSON-LD, favicon, and a concise guide link in the initial HTML. Detailed, no-JavaScript How It Works and FAQ content lives at `/how-it-works`, with page-specific metadata and matching WebPage/FAQPage JSON-LD. Express serves a real `robots.txt` and an XML sitemap listing the homepage and guide page. Unknown URLs return 404 instead of an HTTP 200 copy of the studio. API/auth responses carry `X-Robots-Tag: noindex, nofollow`; robots rules also exclude those paths, not JavaScript/CSS assets.

### 1. Deploy the indexing changes

- Deploy as the existing **Node web service**, not a static upload of `dist/`. Build with `npm ci --include=dev && npm run build` and start with `npm start`. Crawler routes and runtime metadata are provided by Express. Keep the `seo:head` marker pair in both public HTML page templates; the server replaces only each page's metadata block, retaining Vite's asset links and public content.
- Set `SITE_URL=https://sonora.rawse.in` in the service environment. This is the project's default and is included in `render.yaml`. For another deployment, set its real production HTTPS origin **without a trailing slash, path, query, or fragment**. The server derives canonical, structured-data, and sitemap URLs from this fixed setting, never the incoming Host header.
- For this custom domain, also set `PUBLIC_ORIGIN=https://sonora.rawse.in` (or the appropriate existing `PUBLIC_ORIGINS` allowlist). `SITE_URL` selects the canonical website; it does **not** change the API's browser-origin allowlist. Keep the existing OAuth, database, and secret settings unchanged.
- Restart/redeploy after environment changes. Always use HTTPS. Arrange host-level redirects from noncanonical public domains if needed; the app does not redirect based on untrusted Host headers.

### 2. Verify the public URLs before submitting

Check these URLs on the deployed domain, not just localhost:

| URL | Expected result |
| --- | --- |
| `https://sonora.rawse.in/` | HTTP 200 HTML with the text-to-speech intro, guide links, and the correct homepage canonical URL |
| `https://sonora.rawse.in/how-it-works` | HTTP 200 HTML with the guide/FAQ content and the guide canonical URL |
| `https://sonora.rawse.in/robots.txt` | HTTP 200 `text/plain`, `Allow: /`, exclusions only for API/auth, and the absolute sitemap URL |
| `https://sonora.rawse.in/sitemap.xml` | HTTP 200 XML listing the homepage and `https://sonora.rawse.in/how-it-works` |
| `https://sonora.rawse.in/index.html` | HTTP 301 redirect to `/` |
| `https://sonora.rawse.in/no-such-page` | HTTP 404, not the studio HTML |

Do not submit while the homepage returns 503, robots disallows the whole site, or robots/sitemap return app HTML. If Render returns 503 before requests reach Express, inspect the deployment/startup logs, `/api/health`, database availability/expiry, and service status. The free service can spin down; reliable hosting availability matters for crawling. These code changes do not change the service plan or repair an upstream hosting outage.

### 3. Verify ownership in Google Search Console

1. Open [Google Search Console](https://search.google.com/search-console) with the Google account that manages the website.
2. Add a **URL-prefix** property for `https://sonora.rawse.in/` (use the actual `SITE_URL` if different).
3. Choose **HTML tag** verification. From Google's `<meta name="google-site-verification" content="...">`, copy **only the content value** into the service environment variable `GOOGLE_SITE_VERIFICATION`. This is a public ownership token, not an OAuth client secret or API key. Do not paste the whole tag.
4. Redeploy/restart, confirm that tag appears in the homepage's View Source, then click **Verify** in Search Console. Keep the value configured after verification. Alternatively, use Google's DNS verification method if you manage the domain's DNS.

### 4. Submit and monitor

1. In the verified property's **Sitemaps** section, submit `https://sonora.rawse.in/sitemap.xml` (or `sitemap.xml` when the interface already supplies the property prefix).
2. Use **URL Inspection** for `https://sonora.rawse.in/` and `https://sonora.rawse.in/how-it-works`, run **Test live URL**, check that Google can crawl each page, and select **Request indexing**.
3. Monitor URL Inspection and the Page indexing report for errors. A `site:` search alone is not a complete indexing diagnostic. Keep the public site available while Google revisits it.

Search Console submission and the production deployment are account-owner actions; local changes do not perform either action. Google controls inclusion, timing, title/snippet selection, and rankings. Requests and sitemaps do not guarantee indexing or a search position, and crawling can take days to weeks. See Google's [recrawl guidance](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl) and [sitemap submission guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).

Local checks: `node --test test/seo.test.js` exercises crawler routes, metadata/ownership escaping, stable canonicals, private headers, assets, redirects, 404s, and missing-build failures over real HTTP with a fixture. Run `npm test` for all regressions and `npm run build` for the actual Vite output. Then `npm start` serves that build at http://localhost:8787 for a deployment-style check; `npm run dev` alone does not provide the production crawler routes.

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

Responsive dark studio UI, server-reported model/configuration, full 30-name voice roster, explicit character counter, over-limit blocking, locked generation controls, backend-only API key, immutable server instruction, AUDIO-only Live setup, sequential bounded text chunks, multipart audio parsing, timeout/cancellation handling, PCM validation, progressive Web Audio playback, pause/resume, cancellation, and complete mono 24kHz 16-bit WAV playback. After generation, users can export MP3, WAV, FLAC, AAC, or OGG. Guests can export MP3; Google sign-in unlocks the other formats. Transcoding runs locally in the browser, and the first export loads the approximately 32 MB FFmpeg WebAssembly encoder.

The `@ffmpeg/core` WebAssembly encoder is licensed under GPL-2.0-or-later. Its [v0.12.10 source](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10) and license must be included or made available as required by that license; satisfy the corresponding-source and notice requirements before distributing this application.

The UI loads `/api/config` without exposing credentials and disables generation until server configuration is present. Configuration presence does not prove model access. Restart the server after changing `.env`, then use **Retry configuration** in the studio.

Guests have a server-enforced allowance of 50 submitted whitespace-separated words per IP per UTC day. Signing in with Google raises the active allowance to 1,000 words per Google account per UTC day. The account allowance is separate from the guest IP allowance; signing in switches to the account counter. All models share the same counter for that identity. Submitted text includes bracketed delivery tags, and accepted requests count even if synthesis later fails or is cancelled. PostgreSQL stores daily usage by subject type and HMAC hash, not raw IP address or Google account ID. Configure `DATABASE_URL` and a stable `DAILY_QUOTA_SECRET`. The server applies an idempotent schema migration on first database use. In local development without `DATABASE_URL`, it uses a volatile in-memory allowance and logs a warning; production fails closed if PostgreSQL is unavailable or not configured. Behind a reverse proxy, set `TRUST_PROXY` to only trusted proxy IPs/CIDRs so Express can identify clients; never trust arbitrary forwarded IP headers.

### Google sign-in setup

Create a Google OAuth client in Google Cloud Console with the OAuth consent screen configured and an authorized redirect URI exactly matching `https://sonora.rawse.in/auth/google/callback` (use your own production domain if it differs). Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` to the matching OAuth client values; the redirect URI must match exactly. Set a long, random `SESSION_SECRET`. Google sign-in is enabled only when all three `GOOGLE_*` values are present. The Render Blueprint prompts for the OAuth values and generates `SESSION_SECRET`; set `GOOGLE_REDIRECT_URI` to the production callback URL. PostgreSQL stores sessions across service instances. The server validates OAuth state and the Google ID token nonce and audience, and uses a secure, HTTP-only, same-site session cookie. Never commit OAuth secrets.

For temporary administrator access, set `ADMIN_GOOGLE_EMAILS` in Render to a comma-separated allowlist of trusted Google account email addresses. Admins must still complete Google sign-in, and their Google ID token must report a verified email. Only the server grants the admin flag; changing the allowlist invalidates existing admin privileges until the user signs in again. Admin status bypasses only the daily word quota. Per-request character limits, concurrency limits, and audio safety limits remain enforced. Do not use a secret URL or unauthenticated bypass as an admin mechanism.

`POST /api/generate/stream` streams NDJSON `start`, `audio`, `progress`, `done` events. Failures after streaming starts produce `error`, never a successful partial WAV. The browser decodes PCM with explicit little-endian conversion and creates a 24000 Hz AudioContext from the Generate gesture. The older `/api/generate` completed-WAV endpoint remains available.

`test/stream.test.js` uses an injected test-only synthesizer to check real HTTP streaming before completion, validation, sanitized failures, configuration secrecy, origin restrictions, NDJSON boundaries, and PCM conversion. It does not claim to test Google's service or browser audio hardware.

## Remaining work

The browser receives progressive audio over streaming HTTP; only the backend uses the SDK Live WebSocket. Safe acknowledged session resumption, verified per-model voice compatibility and quota metadata, provider-backed tests, browser listening checks, and measured first-audio latency remain pending. Output has a 128 MiB decoded-PCM guard and a separate base64-aware NDJSON wire guard, plus a ten-minute deadline. Browser memory also includes decoded PCM, Float32 samples, and the final WAV; the input cap does not promise a million-character generation will finish.

For local development, the server defaults to loopback, restricts browser origins to explicit local addresses, caps active synthesis at two requests, and aborts slow clients at a bounded stream buffer. The IP-based guest quota is not a reliable identity system: people sharing an IP share one allowance, and changing networks can bypass it. PostgreSQL coordinates quota usage across multiple backend instances. Google OAuth should only be exposed over HTTPS in production.

`render.yaml` provides a free-tier Render demo Blueprint. Create a new Blueprint from the repository and provide `GEMINI_API_KEY` when prompted. To enable Google sign-in, also provide `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`; use the production callback URL configured in Google Cloud. The Blueprint generates `SESSION_SECRET`. It provisions a free web service and free PostgreSQL database, builds with `npm ci && npm run build`, and starts with `npm start`. Render's `RENDER_EXTERNAL_URL` supplies the service origin automatically; set `PUBLIC_ORIGIN` to your custom-domain origin if you add one. It provisions a free PostgreSQL database; the free database is temporary and may expire/delete its data, so do not use it for durable quota history. The free web service may spin down while idle. The Blueprint trusts one Render proxy hop for IP-based quotas. Free tier and plan details can change; verify current limits in Render before deploying.

Guests can generate without an account up to the 50-word IP-based daily allowance; Google sign-in is optional. The IP quota is only a basic usage guard, not strong abuse protection. Avoid exposing a paid provider key without monitoring provider spend and configuring provider-side quotas. For persistent production use, switch to a non-expiring PostgreSQL plan and set the web service plan appropriate to expected usage.
