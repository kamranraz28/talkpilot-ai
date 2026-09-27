require('dotenv').config();
const ari = require('ari-client');
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { GeminiSession, up8to16 } = require('./gemini-session');
const { GoogleGenAI } = require('@google/genai');
const { MediaLink } = require('./media-link');
const { WavWriter, decodeWav, mergeStereo, encodeWav, down24To8, down24To16 } = require('./wav');
const { startSync, syncOnce } = require('./sip-sync');
const { RecordingWatcher } = require('./recording-watcher');

// ---------- CONFIG ----------
const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088';
const ARI_USER = process.env.ARI_USER || 'ariuser';
const ARI_PASS = process.env.ARI_PASS || '12345';
const APP_NAME = process.env.APP_NAME || 'ai-call-asterisk';
const LARAVEL_BASE = process.env.LARAVEL_BASE || 'https://talkpilot.synergyinterface.com';
const LARAVEL_TOKEN = process.env.LARAVEL_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '5300', 10);
const REC_DIR = process.env.REC_DIR || path.join(__dirname, '..', 'recordings');
const UPLOAD_API_KEY = process.env.UPLOAD_API_KEY || '123456';

if (!GEMINI_API_KEY) { console.error('[app] GEMINI_API_KEY missing'); process.exit(1); }
if (!LARAVEL_TOKEN) { console.error('[app] LARAVEL_TOKEN missing (must match talkpilot ASTERISK_TOKEN)'); process.exit(1); }

let ariClient;

// ---------- TalkPilot data ----------
const accounts = new Map();  // sip_number -> account payload (updates from sip-sync)
const byShop = new Map();    // shop_id -> account (greeting cache etc, any number works)

function indexAccounts(list) {
  accounts.clear(); byShop.clear();
  for (const a of list) {
    const num = String(a.sip_number || '');
    accounts.set(num, a);
    accounts.set(num.replace(/\D/g, ''), a);
    if (a.shop_id && !byShop.has(a.shop_id)) byShop.set(a.shop_id, a);
  }
}

async function fetchAccounts() {
  try {
    const list = await syncOnce({
      LARAVEL_BASE, LARAVEL_TOKEN,
      ASTERISK_HOST: process.env.ARI_URL || 'http://127.0.0.1:8088',
    });
    indexAccounts(list);
    console.log(`[sip-accounts] ${accounts.size} index entries loaded`);
  } catch (e) {
    console.error('[sip-accounts] fetch failed:', e.message);
  }
}

// Resolve a shop slug for /api/upload-recording (X-Api-Key mode needs `shop`).
function shopSlug(exten) {
  const a = accounts.get(String(exten)) || accounts.get(String(exten).replace(/\D/g, ''));
  if (!a) return '';
  if (a.slug) return a.slug;
  return String(a.shop_name || a.sip_number || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Convert shop greeting (WAV 24k, from TalkPilot) → 8k PCM for RTP pacing
function greetingPcm(account) {
  try {
    const wav = Buffer.from(account.greeting.audio_base64, 'base64');
    const dec = decodeWav(wav);
    if (!dec || dec.pcm.length < 4) return null;
    if (dec.rate === 8000) return dec.pcm;
    if (dec.rate === 16000) return down16To8(dec.pcm);
    if (dec.rate === 24000) return down24To8(dec.pcm);
    return null;
  } catch { return null; }
}

// 16k → 8k (every 2nd sample)
function down16To8(pcm16) {
  const n = Math.floor(pcm16.length / 4);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(pcm16.readInt16LE(i * 4), i * 2);
  return out;
}

async function summarizeTranscript(lines) {
  const clean = (lines || [])
    .map(l => String(l).trim())
    .filter(l => l.length > 0);
  if (clean.length < 2) return null;
  const transcript = clean.slice(0, 120).join('\n');
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const prompt = `You are a CRM assistant writing the call note for a call-center agent.\nWrite a professional CRM call note in Bengali for this customer call.\nKeep it concise and natural: only the key purpose and outcome of the call.\nMaximum 1-2 short sentences. No labels, no headers, no unnecessary words, no repetition.\nOutput ONLY the note in Bangla.\n\nTranscript:\n${transcript}`;
  const candidates = [
    process.env.NOTE_MODEL,
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash',
    'gemini-flash-latest',
  ].filter(Boolean);
  let lastErr = null;
  for (const model of candidates) {
    try {
      const resp = await ai.models.generateContent({ model, contents: prompt });
      const text = (resp?.text || resp?.response?.text || '').trim();
      if (text && text.length > 0) return text.slice(0, 1000);
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// ---------- per-call flow ----------
async function handleCall(channel, args) {
  const exten = String(args[0] || channel.dialplan?.exten || '');
  const caller = channel.caller?.number || '';
  const callId = uuidv4();
  const t0 = Date.now();
  console.log(`📞 call_id=${callId} from=${caller} to=${exten}`);

  const account = accounts.get(exten) || accounts.get(exten.replace(/\D/g, ''));
  const voice = account?.voice || 'Charon';
  let sysInst = account?.system_instruction || 'You are a helpful call-center agent. Speak naturally, briefly, in the caller\'s language (Bangla/English).';

  // Outbound auto/manual calls carry a per-call script (channel variable set
  // at originate). When present it overrides the shop's general script for
  // THIS call only.
  let perCallScript = null;
  try {
    const script = await channel.getChannelVar({ variable: 'AI_STATUS_SCRIPT' });
    if (script && script.value && String(script.value).trim() !== '') {
      perCallScript = String(script.value);
      sysInst = 'Follow this call script strictly, naturally and briefly, in the caller\'s language (Bangla/English).\n\nSCRIPT:\n' + perCallScript;
    }
  } catch (e) {}
  console.log(perCallScript
    ? `[script] per-call script ACTIVE (${perCallScript.length} chars)`
    : '[script] no per-call script — falling back to shop script');

  // Which outbound_calls row this call belongs to (only for AI outbound jobs).
  let outboundJobId = null;
  try {
    const jobId = await channel.getChannelVar({ variable: 'OUTBOUND_JOB_ID' });
    if (jobId && jobId.value) outboundJobId = Number(jobId.value) || null;
  } catch (e) {}
  if (outboundJobId) console.log(`[note] outbound job id=${outboundJobId}`);

  // Auto-call (order) context: the AI can naturally reference this order number
  // during the conversation, but it is NOT part of the per-call script text.
  let orderNumber = null;
  try {
    const oc = await channel.getChannelVar({ variable: 'ORDER_NUMBER' });
    if (oc && oc.value && String(oc.value).trim() !== '') orderNumber = String(oc.value).trim();
  } catch (e) {}
  if (orderNumber) {
    sysInst += `\n\nCONTEXT: this call is about the customer's order number ${orderNumber}. You may reference it naturally when it helps (e.g., confirming or discussing the order), but only when relevant to the conversation.`;
    console.log(`[order] order number context: ${orderNumber}`);
  }

  // Live transcript lines (caller + agent) collected while Gemini is connected.
  const transcriptLines = [];

  const promptGreeting = () => {
    if (orderNumber) {
      // Order-based auto-call: greet → shop name → order number → script.
      gem.sendText(`You are starting this call now and will speak in Bengali. Open in EXACTLY this order: (1) a warm greeting starting with Assalamu Alaikum, (2) clearly say the shop name "${account?.shop_name || 'our company'}", (3) mention this customer's order number ${orderNumber}. Then continue the conversation following the script below. Do NOT use the generic "আপনি কিভাবে সাহায্য চান" line as the opener.\n\nSCRIPT:\n${perCallScript || 'Speak naturally, briefly and helpfully; find out what the customer needs and help them.'}`);
    } else if (perCallScript) {
      gem.sendText(`You are starting this outbound call now. Greet briefly and warmly in the caller's language (Bengali), then IMMEDIATELY follow THIS call script for the entire conversation. Do NOT use the generic "How can I help you today / আপনি কিভাবে সাহায্য চান" opening — open according to the script and stay fully natural and non-pushy.\n\nSCRIPT:\n${perCallScript}`);
    } else {
      gem.sendText(`Greet the caller now, out loud, in Bengali. Start the greeting with "Assalamu Alaikum" (আসসালামু আলাইকুম) and keep it short and warm, 1 sentence before the shop name. Introduce the shop "${account?.shop_name || 'our company'}" and then ask "আপনি কিভাবে সাহায্য চান?" (How may I help you today?)`);
    }
  };

  let userWav = null, aiWav = null, media = null, gem = null, bridge = null, stereoFile = null, emChannel = null;

  const callT0 = Date.now();

  // RECORDING MIXER — the desktop-app recipe: two concurrent 8 kHz sample queues
  // + ONE stopwatch-driven loop writing remote+local clamped at 8000 Hz.
  // The output position comes from elapsed wall time, so file duration == exact
  // call seconds and the two directions can never drift/stutter. If a side has
  // no new samples for a tick, its last sample is HELD (late packets dropped).
  const SAMPLE_RATE = 8000;
  let mixT0 = null, mixTimer = null, mixWritten = 0;
  const callerQ = { buf: Buffer.alloc(0), read: 0, last: 0, has: false };
  const aiQ = { buf: Buffer.alloc(0), read: 0, last: 0, has: false };
  let monoPcm = Buffer.alloc(0);
  let stereoPcm = Buffer.alloc(0);

  const push8k = (q, buf) => {
    if (!buf || buf.length < 2) return;
    q.buf = Buffer.concat([q.buf, buf]);
    if (q.read > (1 << 20)) { q.buf = q.buf.subarray(q.read); q.read = 0; }
  };
  const take8k = (q, n) => {
    const avail = (q.buf.length - q.read) / 2;
    if (avail >= 1) {
      const end = q.read + Math.min(n, avail) * 2;
      q.last = q.buf.readInt16LE(end - 2);
      q.has = true;
    }
    q.read += Math.min(n, avail) * 2;
  };
  const near8k = (q, i) => {
    const pos = q.read + i * 2;
    if (pos + 2 <= q.buf.length) return q.buf.readInt16LE(pos);
    return q.has ? q.last : 0;
  };

  const mixTick = () => {
    const target = Math.floor(((Date.now() - mixT0) / 1000) * SAMPLE_RATE);
    const n = Math.max(0, Math.min(target - mixWritten, 4000));
    if (n === 0) return;
    const mono = Buffer.alloc(n * 2);
    const st = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const cs = near8k(callerQ, i);
      const as = near8k(aiQ, i);
      let s = cs + as;
      if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
      mono.writeInt16LE(s, i * 2);
      st.writeInt16LE(cs, i * 4);
      st.writeInt16LE(as, i * 4 + 2);
    }
    monoPcm = Buffer.concat([monoPcm, mono]);
    stereoPcm = Buffer.concat([stereoPcm, st]);
    take8k(callerQ, n); take8k(aiQ, n);
    mixWritten += n;
  };
  const mixStart = () => {
    if (mixTimer) return;
    mixT0 = Date.now(); mixWritten = 0;
    mixTimer = setInterval(mixTick, 20);
  };
  const mixFlush = () => {
    if (mixTimer) { clearInterval(mixTimer); mixTimer = null; }
    if (mixT0 === null) return;
    const target = Math.floor(((Date.now() - mixT0) / 1000) * SAMPLE_RATE);
    const n = Math.max(0, target - mixWritten);
    if (n === 0) return;
    const mono = Buffer.alloc(n * 2);
    const st = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const cs = near8k(callerQ, i);
      const as = near8k(aiQ, i);
      let s = cs + as;
      if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
      mono.writeInt16LE(s, i * 2);
      st.writeInt16LE(cs, i * 4);
      st.writeInt16LE(as, i * 4 + 2);
    }
    monoPcm = Buffer.concat([monoPcm, mono]);
    stereoPcm = Buffer.concat([stereoPcm, st]);
    take8k(callerQ, n); take8k(aiQ, n);
    mixWritten += n;
  };
  // Recording-side AI FIFO: clean 16k frames derived from the original 24k
  // Gemini audio, consumed 1:1 by each frame the pacer actually plays (fallback
  // to the 8k upsample if a burst is dropped or not yet produced).
  let ai16Fifo = Buffer.alloc(0);
  const pushAi16 = (buf) => { ai16Fifo = Buffer.concat([ai16Fifo, buf]); if (ai16Fifo.length > 320 * 2 * 500) ai16Fifo = ai16Fifo.subarray(ai16Fifo.length - 320 * 2 * 500); };
  const popAi16 = () => { if (ai16Fifo.length >= 640) { const f = ai16Fifo.subarray(0, 640); ai16Fifo = ai16Fifo.subarray(640); return f; } return null; };

  const finish = async () => {
    try { await gem?.close(); } catch {}

    // Outbound AI: write the short Bangla note of the customer's issue/reason.
    if (outboundJobId) {
      try {
        const note = await summarizeTranscript(transcriptLines);
        if (note) {
          await axios.post(`${LARAVEL_BASE}/api/asterisk/outbound-note`, { id: outboundJobId, note }, {
            headers: { 'X-Asterisk-Token': LARAVEL_TOKEN },
            timeout: 20000,
          });
          console.log(`[note] saved note for job ${outboundJobId}: ${note.slice(0, 80)}`);
        } else {
          console.log(`[note] no transcript for job ${outboundJobId} — skipped`);
        }
      } catch (e) {
        console.error(`[note] save failed for job ${outboundJobId}:`, e.message);
      }
    }
    try { media?.close(); } catch {}
    try { if (emChannel) await emChannel.hangup(); } catch {}   // release the leaked externalMedia leg
    try {
      userWav?.finalize(); aiWav?.finalize();
      mixFlush();   // exact call duration (stopwatch-driven)

      const recDir = process.env.REC_DIR || path.join(__dirname, '..', 'recordings');
      const safeExten = String(exten || '').replace(/\D/g, '');
      const stereoFile = path.join(recDir, `call-${safeExten}-${callId}.wav`);
      const mixFile = path.join(recDir, `mix-${safeExten}-${callId}.wav`);

      // MAIN listening file: 8 kHz / 16-bit / mono — caller + AI mixed with
      // clamping, exactly what the caller heard in real time.
      fs.writeFileSync(mixFile, encodeWav(monoPcm, SAMPLE_RATE, 1));

      // Debug/analytics: 8 kHz stereo — caller left, AI right (same timeline).
      fs.writeFileSync(stereoFile, encodeWav(stereoPcm, SAMPLE_RATE, 2));

      const formData = new FormData();
      formData.append('call_id', callId);
      formData.append('sip_number', exten);
      formData.append('from', caller);
      formData.append('duration', String(Math.round((Date.now() - t0) / 1000)));
      formData.append('called_at', new Date(t0).toISOString());
      formData.append('recording', new Blob([fs.readFileSync(mixFile)], { type: 'audio/wav' }), path.basename(mixFile));
      await axios.post(`${LARAVEL_BASE}/api/asterisk/call-status`, formData, {
        headers: { 'X-Asterisk-Token': LARAVEL_TOKEN },
        timeout: 30000,
      });
      console.log(`[call-finish] uploaded call_id=${callId}`);
    } catch (e) {
      console.error('[call-finish] failed:', e.message);
    }
  };

  try {
    await channel.answer();

    const recDir = path.join(__dirname, '..', 'recordings');
    fs.mkdirSync(recDir, { recursive: true });
    userWav = new WavWriter(path.join(recDir, `user-${callId}.wav`), 16000);
    aiWav = new WavWriter(path.join(recDir, `ai-${callId}.wav`), 8000);

    // realtime AI (Gemini Live) — start connecting NOW, in parallel with the
    // RTP/bridge setup below, so the AI greeting plays within ~1s of answer
    // instead of after the whole media path is serialized first.
const gemOpenPromise = (async () => {
      try {
        gem = new GeminiSession({
          apiKey: GEMINI_API_KEY,
          config: { voice: voice, systemInstruction: sysInst },
          log: (...a) => console.log('[gemini]', ...a),
          onTranscript: (who, text) => {
            if (transcriptLines.length < 400) transcriptLines.push(`${who}: ${text}`);
          },
          onAiAudio: (pcm24k) => {
            const down = down24To8(pcm24k);
            media?.sendAudio(down);
            pushAi16(down24To16(pcm24k));   // recording path: clean 16k from original 24k
          },
          onEnded: () => { Promise.resolve(channel.hangup()).catch(() => {}); },
          onInterrupted: () => media?.flush(),   // caller talks over AI -> stop AI playback now
        });
        await gem.open();
      } catch (e) {
        console.error('[gemini] open failed:', e.message);
      }
    })();

    // Start the greeting as soon as Gemini is open — the audio is buffered by
    // MediaLink (armed=false) and plays the instant the caller is bridged, so
    // the AI's first word is not delayed by post-answer generation.
    const greetingReady = gemOpenPromise
      .then(() => promptGreeting())
      .catch(e => console.error('[gemini] greeting prompt failed:', e.message));

    // Per-call RTP socket: each call binds its OWN unique UDP port (OS-assigned),
    // so concurrent calls on different SIP numbers never collide on one port.
    media = new MediaLink(0, {
      codec: 'ulaw',               // encode/decode G.711 µ-law at the RTP boundary
      // Caller audio: push into the 8k recording queue (already µ-law decoded).
      onUserAudio: (pcm8k) => {
        const pcm16k = up8to16(pcm8k);
        userWav?.write(pcm16k);
        mixStart();
        push8k(callerQ, pcm8k);
        gem?.sendAudio(pcm16k);
      },
      // AI audio: the exact frames played to the caller → AI recording queue.
      onSent: (pcm8k) => {
        aiWav?.write(pcm8k);
        mixStart();
        push8k(aiQ, pcm8k);
      },
    });
    const rtpPort = await media.ready;

    // externalMedia channel: caller's audio (G.711 µ-law) arrives via RTP at rtpPort
    emChannel = ariClient.Channel();
    await emChannel.externalMedia({
      app: APP_NAME,
      encapsulation: 'rtp',
      transport: 'udp',
      connection_type: 'client',   // we listen; Asterisk sends to us at external_host:port
      format: 'ulaw',               // match the trunk's µ-law so Asterisk native-bridges media
      external_host: `127.0.0.1:${rtpPort}`,
      direction: 'both',           // Asterisk↔app: caller in on one dir, AI out on the other
    });

    // learn Asterisk's UnicastRTP port right away so outbound audio
    // (greeting/AI) is never silently dropped waiting for inbound packets
    try {
      await new Promise(r => setTimeout(r, 300));
      const v = await emChannel.getChannelVar({ variable: 'UNICASTRTP_LOCAL_PORT' });
      const port = parseInt(String(v.value || v), 10);
      if (port) {
        media.setRemote({ address: '127.0.0.1', port });
        console.log(`[rtp] remote set 127.0.0.1:${port}`);
      }
    } catch (e) {
      console.log('[rtp] UNICASTRTP_LOCAL_PORT unavailable:', e?.message);
    }

    // bridge caller <-> externalMedia BEFORE greeting so everything flows through RTP
    bridge = ariClient.Bridge();
    await bridge.create({ type: 'mixing' });
    await bridge.addChannel({ channel: channel.id });
    console.log(`[bridge] caller added`);
    await bridge.addChannel({ channel: emChannel.id });
    console.log(`[bridge] external media added bridge=${bridge.id}`);

    // The caller is now connected — release any audio Gemini already produced
    // so it streams immediately (no post-answer generation gap).
    media.arm();

    channel.on('StasisEnd', finish);
  } catch (e) {
    console.error('[call] error:', e);
    try { await channel.hangup(); } catch {}
    await finish();
  }
}

// ---------- main ----------
async function main() {
  ariClient = await ari.connect(ARI_URL, ARI_USER, ARI_PASS);
  console.log(`✅ ARI connected ${ARI_URL} app=${APP_NAME}`);

  // Accept calls IMMEDIATELY (don't block the Stasis subscription on the
  // network fetch below). Calls landing during boot otherwise get dropped as
  // "busy/ended" because the Stasis app isn't registered yet.
  ariClient.on('StasisStart', async (event, channel) => {
    // ignore the externalMedia/UnicastRTP channel itself
    if (channel.name.startsWith('UnicastRTP')) return;
    console.log(`📞 StasisStart ${channel.name} args=${JSON.stringify(event.args)}`);
    handleCall(channel, event.args).catch(e => console.error('[stasis] fatal:', e));
  });
  await ariClient.start(APP_NAME);

  // load SIP accounts in the background; call handler degrades gracefully.
  // Refresh the in-memory account map EVERY minute (not just on boot) — if the
  // boot fetch times out (portal flakiness), an empty map made every outbound
  // call fail with "unknown exten; no sip account" for the whole run.
  fetchAccounts().finally(() => {
    const refresh = async () => {
      try {
        const list = await syncOnce({ LARAVEL_BASE, LARAVEL_TOKEN });
        if (list) indexAccounts(list);
      } catch (e) {
        console.error('[sip-accounts] refresh failed:', e.message);
      }
    };
    setInterval(refresh, 60000);
  });

  // upload every new finished call recording to upload-recording for analytics
  const recWatcher = new RecordingWatcher({
    recDir: REC_DIR,
    laravelBase: LARAVEL_BASE,
    apiKey: UPLOAD_API_KEY,
    resolve: (exten) => {
      const a = accounts.get(String(exten)) || accounts.get(String(exten).replace(/\D/g, ''));
      return { token: a?.api_token, shop: shopSlug(exten) };
    },
  });
  recWatcher.start();

  const app = express();
  app.use(express.json());
  // Originate an AI outbound call via the shop SIP number's outbound endpoint.
  function originateOutbound(phone, exten, script, jobId, orderNumber) {
    const acct = accounts.get(String(exten)) || accounts.get(String(exten).replace(/\D/g, ''));
    if (!acct) return Promise.reject(new Error('unknown exten; no sip account'));
    const opts = {
      endpoint: `PJSIP/${phone}@e_${exten}_${acct.id}`,
      app: APP_NAME,
      appArgs: exten,
      callerId: exten,
      timeout: 45,
    };
    const vars = {};
    if (script && String(script).trim() !== '') vars.AI_STATUS_SCRIPT = String(script);
    if (jobId) vars.OUTBOUND_JOB_ID = String(jobId);
    if (orderNumber) vars.ORDER_NUMBER = String(orderNumber);
    if (Object.keys(vars).length > 0) opts.variables = vars;
    return ariClient.channels.originate(opts);
  }

  // Poll the portal for shop-owner requested AI outbound calls, originate each
  // and report the outcome. Lets a hosted portal queue calls that a customer's
  // local node then places (portal -> node reverse direction is often blocked).
  async function pollOutbound() {
    // Never dial while the account map isn't loaded — it would fail every job
    // with "unknown exten". Leave jobs pending until accounts arrive (≤60s).
    if (accounts.size === 0) {
      console.error('[outbound] account list empty — deferring this poll cycle');
      return;
    }
    try {
      const { data } = await axios.get(`${LARAVEL_BASE}/api/asterisk/outbound-pending`, {
        headers: { 'X-Asterisk-Token': LARAVEL_TOKEN },
        timeout: 30000,
      });
      const jobs = Array.isArray(data) ? data : (data.data || []);
      for (const job of jobs) {
        const report = (status, extra = {}) =>
          axios.post(`${LARAVEL_BASE}/api/asterisk/outbound-result`, {
            id: job.id, status, ...extra,
          }, { headers: { 'X-Asterisk-Token': LARAVEL_TOKEN }, timeout: 30000 })
            .catch(e => console.error(`[outbound] result report job=${job.id} failed:`, e.message));
        try {
          const ch = await originateOutbound(String(job.phone || ''), String(job.exten || ''), job.script, job.id, job.order_number);
          console.log(`[outbound] job=${job.id} originated ${ch.id} to ${job.phone} via ${job.exten}`);
          await report('completed', { channel_id: ch.id });
        } catch (e) {
          console.error(`[outbound] job=${job.id} (${job.phone} via ${job.exten}) failed:`, e.message);
          if (String(e.message).includes('unknown exten')) {
            // Definitive config problem — mark failed so it isn't retried forever.
            await report('failed', { error: String(e.message).slice(0, 500) });
          } else {
            // Transient (Asterisk down / network): leave it to be reclaimed by
            // the portal (dispatched + no channel_id > 3 min → re-opened) and
            // retried on a later poll. Never lose the call.
            console.error(`[outbound] job=${job.id} is a TRANSIENT failure — left for automatic retry`);
          }
        }
      }
    } catch (e) {
      console.error('[outbound] poll error:', e.message);
    }
  }

  // outbound AI call: POST /call { phone, exten (sip number the AI should call out as) }
  app.post('/call', (req, res) => {
    const { phone, exten, } = req.body;
    if (!phone || !exten) return res.status(400).json({ error: 'phone & exten required' });
    originateOutbound(String(phone), String(exten))
      .then(ch => res.json({ success: true, channel_id: ch.id }))
      .catch(e => res.status(500).json({ error: e.message }));
  });
  app.get('/health', (req, res) => res.json({ ok: true, app: APP_NAME, accounts: accounts.size }));

  // kick the outbound queue poller
  pollOutbound();
  setInterval(pollOutbound, 30000);

  app.listen(HTTP_PORT, () => console.log(`🚀 API on :${HTTP_PORT}`));
}

main().catch(e => { console.error('❌', e); process.exit(1); });
