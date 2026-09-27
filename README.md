# AI Call — Asterisk (ARI + Gemini Live)

Asterisk ARI application that answers inbound SIP calls in **AI mode** and
runs a **realtime conversation with Gemini Live** (audio in, audio out). The
AI speaks a live greeting as soon as the call is received, then continues the
conversation naturally. Every call is recorded to a **single mono WAV** (caller
+ AI voices mixed) and pushed to the TalkPilot backend.

## How it works

1. An inbound call reaches Asterisk (`extensions.conf` → `from-trunk`).
2. The mode API decides `ai` vs `manual`; AI-mode calls enter Stasis.
3. The app:
   - answers the call,
   - creates an `externalMedia` (UnicastRTP) leg on the media port,
   - bridges the caller with that leg,
   - connects **Gemini Live** and prompts it to greet the caller live (so the
     first thing the caller hears is the AI welcome),
   - streams callers audio → Gemini and Gemini audio → the caller in real time.
4. On hangup the app writes `call-<exten>-<callId>.wav` (one mono file, both
   voices mixed) and POSTs the call status + recording to TalkPilot.

## Key components

| File | Purpose |
|------|---------|
| `src/index.js` | ARI Stasis app, per-call flow, call-status/recording upload, HTTP API |
| `src/gemini-session.js` | Gemini Live realtime session (16 kHz PCM in, 24 kHz PCM out) |
| `src/media-link.js` | RTP boundary in **G.711 µ-law** (matches the trunk codec so Asterisk can native-bridge), 20 ms pacer |
| `src/sip-sync.js` | Pulls SIP accounts from TalkPilot, generates `pjsip_accounts.conf`, reloads PJSIP |
| `src/recording-watcher.js` | Watches `recordings/` and uploads every finished `call-*.wav` to `/api/upload-recording` for Gemini transcription |
| `src/wav.js` | WAV writer utilities + mono-mix of the two call legs |

### Codec note

The `externalMedia` leg and the RTP socket use **µ-law (G.711)** — the same
codec negotiated on the SIP trunk — so Asterisk can bridge the caller and the
AI media leg natively (a `slin` vs `ulaw` mismatch silently kills all audio).
PCM conversion (µ-law ↔ 16-bit signed linear) happens inside `media-link.js`.

## Setup

Copy `.env.example` → `.env` and fill in:

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Gemini API key for the Live session |
| `LARAVEL_TOKEN` | TalkPilot `X-Asterisk-Token` (must match the backend) |
| `ARI_URL` / `ARI_USER` / `ARI_PASS` | Asterisk ARI connection |
| `HTTP_PORT` | App HTTP API port (default `5300`) |
| `LARAVEL_BASE` | TalkPilot base URL |
| `UPLOAD_API_KEY` | Key for `/api/upload-recording` (default `123456`) |
| `DEFAULT_LIVE_MODEL` | Gemini Live model id |

```bash
npm install
node src/index.js
```

The app loads SIP accounts from TalkPilot on boot (and re-syncs every 60 s),
writes `/etc/asterisk/pjsip_accounts.conf` and reloads PJSIP when it changes.
Run it as root (it writes Asterisk configs) — a `systemd` unit is included
conceptually in `require(asterisk.service)`.

## HTTP API

- `GET /health` — `{ ok: true, app, accounts }`
- `POST /call` — outbound AI call: `{ phone, exten }` (originates via the
  PJSIP endpoint registered for that shop SIP number)

## Environment / operations

- Asterisk dialplan: `from-trunk` handles inbound; AI-mode is decided per DIDs.
- Recordings land in `./recordings` as `call-<exten>-<callId>.wav` — a single
  **16 kHz stereo** file (caller left, AI right) on one exact real-time timeline
  (caller by RTP clock, AI at the moment it plays; pauses and overlap preserved;
  legs kept separate so each voice keeps full quality — no summing) and are:
  1. uploaded to `{LARAVEL_BASE}/api/asterisk/call-status` on completion, and
  2. picked up by the **recording watcher** and POSTed to
     `{LARAVEL_BASE}/api/upload-recording`
     (`X-Api-Key`, multipart `audio` + `shop` + `duration` + `channel_count=1`).
- The watcher ignores files that existed before it started and keeps a
  `recordings/.uploaded.json` state file so nothing is uploaded twice; failed
  uploads retry up to 5 times.
- Each call binds its **own unique RTP UDP port** (OS-assigned via `bind(0)`),
  so concurrent calls on different SIP numbers don't collide. `externalMedia`
  is created with the call's exact port.
- `UPLOAD_API_KEY` (default `123456`) configures the watcher's API key. Set
  `REC_DIR` to relocate recordings.