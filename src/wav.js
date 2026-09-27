// Minimal WAV writer: streaming 16-bit LE PCM chunks into a file.
const fs = require('fs');

class WavWriter {
  constructor(file, sampleRate, channels = 1) {
    this.file = file; this.sampleRate = sampleRate; this.channels = channels;
    this.chunks = []; this.fd = fs.openSync(file, 'w');
  }
  write(pcm) { this.chunks.push(pcm); }
  pcmData() { return Buffer.concat(this.chunks); }
  finalize() {
    const rate = this.sampleRate || 16000, chan = this.channels || 1, data = this.pcmData();
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8); header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(chan, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * chan * 2, 28);
    header.writeUInt16LE(chan * 2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(data.length, 40);
    fs.writeSync(this.fd, header, 0, 44, 0);
    fs.writeSync(this.fd, data, 0, data.length, 44);
    fs.closeSync(this.fd); this.fd = null;
  }
}

// Map a raw PCM WAV (16-bit LE) into { rate, channels, pcm (Buffer) }
function decodeWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  // find 'data' chunk robustly (fmt may carry extra bytes)
  let off = 12, rate = 16000, channels = 1, dataSize = 0, dataOff = -1;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); }
    if (id === 'data') { dataOff = off + 8; dataSize = Math.min(size, buf.length - dataOff); break; }
    off += 8 + size + (size & 1);
  }
  return dataOff >= 0 ? { rate, channels, pcm: buf.subarray(dataOff, dataOff + dataSize) } : null;
}

//Mix two 16k mono PCM legs into ONE 16k mono buffer (both voices in the same channel)
function mixMono(a, b) {
  const frames = Math.max(a.length, b.length) / 2;
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const u = i * 2 < a.length ? a.readInt16LE(i * 2) : 0;
    const v = i * 2 < b.length ? b.readInt16LE(i * 2) : 0;
    out.writeInt16LE((u + v) >> 1, i * 2);
  }
  return out;
}

//Merge two 16k mono PCM legs into ONE 16k stereo buffer (user left, ai right)
function mergeStereo(userPcm, aiPcm) {
  const frames = Math.max(userPcm.length, aiPcm.length) / 2;
  const out = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const u = i * 2 < userPcm.length ? userPcm.readInt16LE(i * 2) : 0;
    const a = i * 2 < aiPcm.length ? aiPcm.readInt16LE(i * 2) : 0;
    out.writeInt16LE(u, i * 4);
    out.writeInt16LE(a, i * 4 + 2);
  }
  return out;
}

function encodeWav(pcm, rate, channels) {
  const data = pcm, header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// simple linear resampler (24k → 8k, every 3rd sample)
function down24To8(pcm24) {
  const n = Math.floor(pcm24.length / 6);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(pcm24.readInt16LE(i * 6), i * 2);
  return out;
}
// 24k → 16k linear resampler (factor 2/3). Used for the RECORDING so the AI leg
// is captured from the original Gemini audio instead of the aliased 8k decimate.
function down24To16(pcm24) {
  const inN = pcm24.length / 2;
  const n = Math.floor(inN * 2 / 3);
  const out = Buffer.alloc(n * 2);
  for (let m = 0; m < n; m++) {
    const p = m * 1.5;
    const i = Math.floor(p);
    const f = p - i;
    const a = pcm24.readInt16LE(i * 2);
    const v = (i + 1 < inN) ? a + (pcm24.readInt16LE((i + 1) * 2) - a) * f : a;
    out.writeInt16LE(Math.round(v), m * 2);
  }
  return out;
}
// 8k → 16k linear upsample
function up8to16(pcm8) {
  const n = pcm8.length / 2, out = Buffer.alloc(n * 4);
  for (let i = 0; i < n - 1; i++) {
    const a = pcm8.readInt16LE(i * 2), b = pcm8.readInt16LE(i * 2 + 2);
    out.writeInt16LE(a, i * 4);
    out.writeInt16LE(Math.round((a + b) / 2), i * 4 + 2);
  }
  const last = pcm8.readInt16LE((n - 1) * 2);
  out.writeInt16LE(last, (n - 1) * 4);
  out.writeInt16LE(last, (n - 1) * 4 + 2);
  return out;
}

module.exports = { WavWriter, decodeWav, mergeStereo, mixMono, encodeWav, down24To8, down24To16, up8to16 };
