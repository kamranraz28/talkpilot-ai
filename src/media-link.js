// MediaLink: RTP server on UDP that Asterisk externalMedia streams caller audio into.
// Also sends AI audio back to Asterisk (same socket → remote learned from first packet).
// Codec: 'ulaw' (G.711 µ-law) by default — matches the trunk/PJSIP caller so Asterisk
// can use a native bridge between the caller and the externalMedia leg.
const dgram = require('dgram');

const RTP_HDR = 12;

// --- G.711 µ-law (PCM16 <-> ulaw byte) ---
const ULAW_BIAS = 0x84;

// Decode: ulaw byte -> 16-bit signed PCM sample (standard µ-law expansion)
const ULAW_DEC = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i;
    const sign = u & 0x80;
    const exp = (u >> 4) & 0x07;
    const mant = u & 0x0f;
    let sample = ((mant << 3) + ULAW_BIAS) << exp;
    sample -= ULAW_BIAS;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

// Encode: 16-bit signed PCM sample -> ulaw byte (standard µ-law compression)
function lin2ulaw(pcm) {
  let sign = (pcm >> 8) & 0x80;
  if (sign) pcm = -pcm;
  if (pcm > 32635) pcm = 32635;
  pcm += ULAW_BIAS;
  let exp = 7;
  let mask = 0x4000;
  for (; exp > 0; exp--) { if (pcm & mask) break; mask >>= 1; }
  const mant = (pcm >> (exp + 3)) & 0x0f;
  return ((sign | (exp << 4) | mant) ^ 0xff) & 0xff;
}

function pcm16ToUlaw(bufPcm) {           // 8k PCM16 mono -> ulaw bytes (+ pad to 20ms frame)
  const out = Buffer.alloc(bufPcm.length / 2 + 160);
  let n = 0;
  for (let i = 0; i + 1 < bufPcm.length; i += 2) out[n++] = lin2ulaw(bufPcm.readInt16LE(i));
  // pad tail with silence (ulaw 0xff = zero) to a full 160-byte (20ms) frame
  while (n % 160 !== 0) out[n++] = 0xff;
  return { buf: out.subarray(0, n), full: n % 160 === 0 };
}
function ulawToPcm16(bufUlaw) {           // ulaw bytes -> 8k PCM16 mono
  const out = Buffer.alloc(bufUlaw.length * 2);
  for (let i = 0; i < bufUlaw.length; i++) out.writeInt16LE(ULAW_DEC[bufUlaw[i]], i * 2);
  return out;
}

class MediaLink {
  constructor(port, { onUserAudio, codec = 'ulaw', onSent }) {
    this.onUserAudio = onUserAudio;
    this.onSent = onSent;
    this.codec = codec;
    this.seq = Math.floor(Math.random() * 0xffff);
    this.ts = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = Math.floor(Math.random() * 0xffffffff);
    this.remote = null;
    this.pt = this.codec === 'ulaw' ? 0 : 118;   // static PT: ulaw=0, slin(dynamic fallback) 118
    this.port = 0;
    this.userTsBase = null;                        // first inbound RTP ts = real-time anchor

    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg, rinfo) => {
      if (!this.remote) { this.remote = rinfo; console.log(`[rtp] remote ${rinfo.address}:${rinfo.port}`); }
      if (msg.length > RTP_HDR) {
        const pt = msg[1] & 0x7f;
        if (pt >= 96) this.pt = pt;
        // Asterisk sends G.711 µ-law for codec 'ulaw'
        const payload = msg.subarray(RTP_HDR);
        const pcm = this.codec === 'ulaw' ? ulawToPcm16(payload) : payload;
        // absolute position of this chunk in the 8k sample timeline (RTP clock)
        if (this.userTsBase === null) this.userTsBase = msg.readUInt32BE(4);
        const pos8k = msg.readUInt32BE(4) - this.userTsBase;
        this.onUserAudio?.(pcm, pos8k);
      }
    });
    this.sock.on('error', e => console.error('[rtp] sock error', e.message));

    // Bind a unique UDP port per call (port 0 => OS-assigned, collision-free),
    // then resolve with the real port so Asterisk's externalMedia can target it.
    // `ready` must be awaited before externalMedia is created.
    this.ready = new Promise((resolve, reject) => {
      this.sock.once('listening', () => {
        this.port = this.sock.address().port;
        console.log(`[rtp] listening :${this.port}`);
        resolve(this.port);
      });
      this.sock.once('error', reject);
      this.sock.bind(port);
    });

    this.outQueue = [];
    this.armed = false;                       // stream only once the caller is bridged (gentle)
    this.outBase = null;                      // RTP ts of the first sent frame = AI timeline origin
    this.pacer = setInterval(() => {
      // hold audio until the bridge is live AND Asterisk's RTP remote is known
      // instead of dropping it, so the AI greeting is never lost to a slow
      // port-learn or late inbound packet
      if (!this.armed || !this.remote || this.outQueue.length === 0) return;
      const chunk = this.outQueue.shift();
      if (this.outBase === null) this.outBase = this.ts;
      const pos8k = this.ts - this.outBase;   // this frame's position on the AI RTP timeline
      this.#send(chunk.buf);
      this.onSent?.(chunk.pcm, pos8k);        // exact RTP position of when it plays to the caller
    }, 20);
  }

  setRemote(rinfo) { this.remote = rinfo; }

  // Unblock streaming — call once the caller + externalMedia are bridged so
  // any AI audio generated/queued during call setup plays from the very start.
  arm() { this.armed = true; }

  // Drop any AI audio still waiting to be played (used on barge-in, so the
  // caller immediately stops hearing the model instead of draining the buffer).
  flush() { this.outQueue = []; }

  // queue outbound audio; a 20ms pacer sends it at realtime so Asterisk's
  // RTP stream stays continuous (bursts get dropped by the jitter buffer).
  // Audio is buffered until the RTP remote is known (never dropped).
  sendAudio(pcm8k) {
    if (!pcm8k || pcm8k.length < 2) return;
    if (this.codec === 'ulaw') {
      // split into 20ms PCM frames (160 samples / 320 bytes), then µ-law encode
      for (let p = 0; p < pcm8k.length; p += 320) {
        const frame = pcm8k.subarray(p, p + 320);
        const full = frame.length === 320 ? frame : Buffer.concat([frame, Buffer.alloc(320 - frame.length)]);
        this.outQueue.push({ buf: pcm16ToUlaw(full).buf, pcm: full });
      }
    } else {
      let buf = pcm8k;
      const rem = buf.length % 320;                    // 20ms slin frame = 320 bytes
      if (rem !== 0) buf = Buffer.concat([buf, Buffer.alloc(320 - rem, 0)]);
      for (let off = 0; off < buf.length; off += 320) this.outQueue.push({ buf: buf.subarray(off, off + 320), pcm: buf.subarray(off, off + 320) });
    }
    while (this.outQueue.length > 4000) this.outQueue.shift(); // generous cap (~80s); never drop the greeting start
  }

  #send(payload) {
    if (this.remote) {
    this.seq = (this.seq + 1) & 0xffff;
    this.ts += this.codec === 'ulaw' ? 160 : 160;
    const hdr = Buffer.alloc(RTP_HDR);
    hdr[0] = 0x80;
    hdr[1] = this.pt;
    hdr.writeUInt16BE(this.seq, 2);
    hdr.writeUInt32BE(this.ts, 4);
    hdr.writeUInt32BE(this.ssrc, 8);
    this.sock.send(Buffer.concat([hdr, payload]), this.remote.port, this.remote.address);
    }
  }

  close() {
    if (this.pacer) clearInterval(this.pacer);
    try { this.sock.close(); } catch {}
  }
}

module.exports = { MediaLink };