const { GoogleGenAI, Modality } = require('@google/genai');

// Realtime AI session (Trimmed Gemini Live wrapper: audio in 16k, audio out 24k)
function up8to16(pcm8) {                     // mono 8k → 16k (linear)
  const n = pcm8.length / 2; const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n - 1; i++) {
    const a = pcm8.readInt16LE(i * 2), b = pcm8.readInt16LE(i * 2 + 2);
    out.writeInt16LE(a, i * 4);
    out.writeInt16LE(Math.round((a + b) / 2), i * 4 + 2);
  }
  out.writeInt16LE(pcm8.readInt16LE((n - 1) * 2), (n - 1) * 4);
  out.writeInt16LE(pcm8.readInt16LE((n - 1) * 2), (n - 1) * 4 + 2);
  return out;
}

class GeminiSession {
  constructor({ apiKey, config = {}, log = () => {}, onAiAudio, onEnded, onInterrupted, onTranscript }) {
    this.log = log; this.onAiAudio = onAiAudio; this.onEnded = onEnded; this.onInterrupted = onInterrupted;
    this.onTranscript = onTranscript;
    this.closed = false;
    this.ai = new GoogleGenAI({ apiKey });
    this.cfg = config;
  }

  async open() {
    const model = process.env.DEFAULT_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-09-2025';
    this.live = await this.ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: this.cfg.systemInstruction,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.cfg.voice } } },
        thinkingConfig: { thinkingBudget: 0 },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => this.log(`connected model=${model} voice=${this.cfg.voice}`),
        onmessage: (ev) => {
          const sc = ev.serverContent;
          if (sc?.interrupted) {
            this.log('caller barge-in');
            this.onInterrupted?.();
          }
          if (sc?.inputTranscription?.text) {
            this.log(`caller: ${sc.inputTranscription.text}`);
            this.onTranscript?.('caller', sc.inputTranscription.text);
          }
          if (sc?.outputTranscription?.text) {
            this.log(`agent: ${sc.outputTranscription.text}`);
            this.onTranscript?.('agent', sc.outputTranscription.text);
          }
          for (const part of sc?.modelTurn?.parts || []) {
            if (part.inlineData?.data) {
              const pcm = Buffer.from(part.inlineData.data, 'base64'); // 24k
              this.onAiAudio?.(pcm);
            }
          }
        },
        onerror: (e) => this.log('error:', e?.message || e),
        onclose: (e) => this.log('closed:', e?.reason || e?.code || ''),
      },
    });
  }

  sendAudio(pcm16k) {
    if (!this.live || this.closed) return;
    try {
      this.live.sendRealtimeInput({ audio: { data: Buffer.from(pcm16k).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    } catch (e) { this.log('send failed:', e.message); }
  }

  sendText(text) {
    if (!this.live || this.closed) return;
    try {
      this.live.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
      this.log(`prompt: ${text}`);
    } catch (e) { this.log('sendText failed:', e.message); }
  }

  async close() {
    if (this.closed) return; this.closed = true;
    try { await this.live?.close(); } catch {}
    this.onEnded?.();
  }
}

module.exports = { GeminiSession, up8to16 };