// RecordingWatcher: watches the recordings directory and uploads every new
// call-*.wav to {LARAVEL_BASE}/api/upload-recording for Gemini transcription.
// Pure post-processing — does NOT touch the codec, RTP, or audio pipeline.
// Polls (instead of fs.watch) because recordings may live on mounted/shared
// folders where fs.watch events are unreliable.
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STATE_FILE = '.uploaded.json';
const READY_MS = 800;      // file must keep the same size this long before upload
const MIN_SIZE = 400;      // ignore empty/header-only files

const CALL_RE = /^call-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.wav$/;

class RecordingWatcher {
  constructor({ recDir, laravelBase, apiKey = '123456', resolve, pollMs = 1000, maxRetries = 5, log = console.log }) {
    this.recDir = recDir;
    this.laravelBase = laravelBase;
    this.apiKey = apiKey;
    this.resolve = resolve;         // (exten) -> { token?: portal Sanctum bearer, shop?: slug }
    this.pollMs = pollMs;
    this.maxRetries = maxRetries;
    this.log = log;

    this.seen = new Map();        // name -> { size, since }
    this.attempts = new Map();    // name -> retry count
    this.pending = new Set();     // name -> upload currently in flight
    this.processed = new Set();   // name -> done (uploaded or dropped)
  }

  start() {
    this.loadState();
    // Mark files that already exist now as done so only NEW recordings upload.
    try {
      for (const name of fs.readdirSync(this.recDir)) {
        if (CALL_RE.test(name)) this.processed.add(name);
      }
      this.saveState();
    } catch (e) {
      this.log(`[rec-watch] cannot scan ${this.recDir}: ${e.message}`);
    }
    this.log(`[rec-watch] watching ${this.recDir} -> ${this.laravelBase}/api/upload-recording`);
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  loadState() {
    try {
      const { processed = [] } = JSON.parse(fs.readFileSync(path.join(this.recDir, STATE_FILE), 'utf8'));
      this.processed = new Set(processed);
    } catch {
      this.processed = new Set();
    }
  }

  saveState() {
    try {
      fs.writeFileSync(path.join(this.recDir, STATE_FILE), JSON.stringify({ processed: [...this.processed] }));
    } catch (e) {
      this.log(`[rec-watch] state save failed: ${e.message}`);
    }
  }

  tick() {
    let names;
    try { names = fs.readdirSync(this.recDir); } catch { return; }
    const now = Date.now();

    for (const name of names) {
      if (!CALL_RE.test(name) || this.processed.has(name) || this.pending.has(name)) continue;
      const file = path.join(this.recDir, name);
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (size < MIN_SIZE) { this.seen.delete(name); continue; }

      const prev = this.seen.get(name);
      if (prev && prev.size === size && now - prev.since >= READY_MS) {
        this.seen.delete(name);
        this.upload(file, name);
      } else {
        this.seen.set(name, { size, since: (prev && prev.size === size) ? prev.since : now });
      }
    }

    // drop bookkeeping for files that vanished
    for (const name of [...this.seen.keys()]) {
      const f = path.join(this.recDir, name);
      let ok = true;
      try { fs.accessSync(f); } catch { ok = false; }
      if (!ok) this.seen.delete(name);
    }
  }

  async upload(file, name) {
    // reserve this file immediately so a later poll can't re-upload it while
    // the network request is still in flight (prevents duplicate uploads)
    this.pending.add(name);
    const attempt = (this.attempts.get(name) || 0) + 1;
    this.attempts.set(name, attempt);

    const m = name.match(CALL_RE);
    const exten = m ? m[1] : '';
    const acct = this.resolve ? (this.resolve(exten) || {}) : {};
    const token = acct.token;
    const slug = acct.shop;
    if (!token && !slug) {
      this.log(`[rec-upload] skip ${name}: no shop account (exten='${exten}')`);
      this.markProcessed(name);
      return;
    }

    let duration = 0;
    try { duration = Math.max(0, Math.round((fs.statSync(file).size - 44) / 4 / 16000)); } catch {}   // 16kHz stereo
    const form = new FormData();
    form.append('audio', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), path.basename(file));
    if (token) {
      // per-shop Sanctum bearer: endpoint resolves the shop from the token
      form.append('duration', String(duration));
      form.append('channel_count', '1');
    } else {
      form.append('shop', slug);
      form.append('duration', String(duration));
      form.append('channel_count', '1');
    }

    try {
      const res = await axios.post(`${this.laravelBase}/api/upload-recording`, form, {
        headers: token ? { Authorization: `Bearer ${token}` } : { 'X-Api-Key': this.apiKey },
        timeout: 30000,
      });
      const d = res.data || {};
      this.log(`[rec-upload] ${name} -> ${res.status} ${d.status || ''} id=${d.audio_file_id || '?'} credits=${d.credits_consumed ?? '?'} shop=${slug || '(token)'} dur=${duration}s`);
      this.markProcessed(name);
    } catch (e) {
      const code = e?.response?.status || e?.code || e?.message || 'err';
      this.log(`[rec-upload] FAIL ${name} (${attempt}/${this.maxRetries}) ${code}`);
      if (attempt >= this.maxRetries) this.markProcessed(name);
      else this.pending.delete(name);   // free it so the next poll can retry
    }
  }

  markProcessed(name) {
    this.pending.delete(name);
    this.processed.add(name);
    this.attempts.delete(name);
    this.saveState();
  }
}

module.exports = { RecordingWatcher };