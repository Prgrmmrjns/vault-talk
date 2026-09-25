import { requestUrl } from "obsidian";
import {
  DEFAULT_KOKORO_URL,
  DEFAULT_WHISPER_URL,
  MISTRAL_API,
  openaiRoot,
  parseJson,
} from "./providers";
import type { LMVoiceSettings } from "./settings";
import { txt } from "./txt";
import { type LiveHandlers } from "./stt-stream";
import { b64enc } from "./voice-pcm";

type RecLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: {
    resultIndex: number;
    results: { length: number; [i: number]: { isFinal?: boolean; 0?: { transcript?: string } } };
  }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

const API = "https://api.x.ai/v1";
const SILENCE_MS = 10_000;

function multipart(fields: Record<string, string>, filename: string, bytes: Uint8Array, mime: string) {
  const boundary = "----ObsidianForm" + Date.now();
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const push = (s: string | Uint8Array) => chunks.push(typeof s === "string" ? enc.encode(s) : s);
  for (const [k, v] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
  );
  push(bytes);
  push(`\r\n--${boundary}--\r\n`);
  let len = 0;
  for (const c of chunks) len += c.byteLength;
  const body = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    body.set(c, o);
    o += c.byteLength;
  }
  return { boundary, body };
}

function pickMime() {
  const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const t of opts) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function watchSilence(stream: MediaStream, onFire: () => void) {
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AC) return () => {};
  const ctx = new AC();
  void ctx.resume?.();
  const src = ctx.createMediaStreamSource(stream);
  const anal = ctx.createAnalyser();
  anal.fftSize = 2048;
  src.connect(anal);
  const data = new Uint8Array(anal.fftSize);
  let quietAt = 0;
  let fired = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.clearInterval(id);
    void ctx.close();
  };
  const id = window.setInterval(() => {
    anal.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = ((data[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const now = Date.now();
    if (rms > 0.035) {
      quietAt = 0;
    } else {
      if (!quietAt) quietAt = now;
      if (now - quietAt > SILENCE_MS && !fired) {
        fired = true;
        close();
        onFire();
      }
    }
  }, 60);
  return () => {
    if (fired) return;
    fired = true;
    close();
    onFire();
  };
}

export class VoiceIO {
  private audio: HTMLAudioElement | null = null;
  private unvad: (() => void) | null = null;
  private rec: MediaRecorder | null = null;
  private recWeb: RecLike | null = null;
  private cancelled = false;
  private stopping = false;

  constructor(
    private settings: () => LMVoiceSettings,
    private key: () => Promise<string>,
    private mistralKey: () => Promise<string> = async () => "",
    private openaiKey: () => Promise<string> = async () => "",
    private googleKey: () => Promise<string> = async () => ""
  ) {}

  cancelSpeak() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
  }

  stopListen() {
    this.stopping = true;
    this.unvad?.();
    this.unvad = null;
    try {
      this.recWeb?.stop();
    } catch {
      /* ignore */
    }
    this.recWeb = null;
    try {
      if (this.rec && this.rec.state !== "inactive") {
        this.rec.requestData();
        this.rec.stop();
      }
    } catch {
      /* ignore */
    }
  }

  cancelListen() {
    this.cancelled = true;
    this.stopListen();
  }

  async listenLive(handlers: LiveHandlers): Promise<string> {
    this.cancelled = false;
    this.stopping = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone not available. Allow mic for Obsidian.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.cancelled) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Cancelled");
    }
    const live: LiveHandlers = {
      ...handlers,
      onText: (full) => handlers.onText(full),
    };
    try {
      return await this.listenChunks(stream, live);
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  private async listenChunks(stream: MediaStream, handlers: LiveHandlers): Promise<string> {
    if (typeof MediaRecorder === "undefined") throw new Error("Microphone not available. Allow mic for Obsidian.");
    const mime = pickMime();
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    this.rec = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.start(250);

    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    let ctx: AudioContext | null = null;
    let vadTimer = 0;
    if (Ctx) {
      ctx = new Ctx();
      await ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let speaking = false;
      let loud = 0;
      let quiet = 0;
      vadTimer = window.setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = ((buf[i] ?? 128) - 128) / 128;
          sum += v * v;
        }
        const level = Math.sqrt(sum / buf.length);
        handlers.onLevel?.(level);
        if (level > 0.018) {
          loud++;
          quiet = 0;
        } else {
          quiet++;
          loud = 0;
        }
        const next = speaking ? quiet < 10 : loud >= 2;
        if (next !== speaking) {
          speaking = next;
          handlers.onVad?.(speaking);
        }
      }, 80);
    }

    let last = "";
    let lastErr = "";
    let busy = false;
    const tick = window.setInterval(() => {
      if (busy || this.cancelled || this.stopping || !chunks.length) return;
      busy = true;
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
      const ext = (blob.type || "").includes("mp4") ? "m4a" : "webm";
      void blob
        .arrayBuffer()
        .then((buf) => this.transcribeBytes(new Uint8Array(buf), `speech.${ext}`, blob.type || "audio/webm"))
        .then((text) => {
          if (!text || this.cancelled) return;
          last = text;
          lastErr = "";
          handlers.onText(text);
        })
        .catch((err) => {
          lastErr = err instanceof Error ? err.message : String(err);
          handlers.onError?.(lastErr);
        })
        .finally(() => {
          busy = false;
        });
    }, 1400);

    try {
      await new Promise<void>((resolve) => {
        const poll = () => {
          if (this.cancelled || this.stopping) {
            resolve();
            return;
          }
          window.setTimeout(poll, 80);
        };
        poll();
      });
      window.clearInterval(tick);
      window.clearInterval(vadTimer);
      await ctx?.close().catch(() => {});
      if (this.cancelled) {
        try {
          if (rec.state !== "inactive") rec.stop();
        } catch {
          /* ignore */
        }
        this.rec = null;
        throw new Error("Cancelled");
      }
      const blob = await new Promise<Blob>((resolve, reject) => {
        rec.onerror = () => reject(new Error("Recording failed"));
        rec.onstop = () => {
          this.rec = null;
          resolve(new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }));
        };
        try {
          if (rec.state !== "inactive") {
            rec.requestData();
            rec.stop();
          } else resolve(new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }));
        } catch {
          resolve(new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }));
        }
      });
      if (!blob.size) {
        if (last) return last;
        if (lastErr) throw new Error(lastErr);
        return last;
      }
      const ext = (blob.type || "").includes("mp4") ? "m4a" : "webm";
      try {
        const text = await this.transcribeBytes(new Uint8Array(await blob.arrayBuffer()), `speech.${ext}`, blob.type || "audio/webm");
        if (text) handlers.onText(text);
        return text || last;
      } catch (err) {
        if (last) return last;
        throw err;
      }
    } finally {
      window.clearInterval(tick);
      window.clearInterval(vadTimer);
      await ctx?.close().catch(() => {});
      this.rec = null;
    }
  }

  async listenTurn(): Promise<string> {
    this.cancelled = false;
    return this.listenCloud();
  }

  private listenBrowser(): Promise<string> {
    const w = window as Window & { SpeechRecognition?: new () => RecLike; webkitSpeechRecognition?: new () => RecLike };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) throw new Error("This computer has no speech recognition. Switch STT to Grok, or type.");
    return new Promise((resolve, reject) => {
      const rec = new Ctor();
      this.recWeb = rec;
      rec.lang = "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let done = false;
      let prefix = "";
      let heard = "";
      let silenceId = 0;
      const finish = (err?: Error, text?: string) => {
        if (done) return;
        done = true;
        window.clearTimeout(silenceId);
        this.recWeb = null;
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
        const out = (text || "").trim();
        if (err) reject(err);
        else if (!out) reject(new Error("Empty transcript"));
        else resolve(out);
      };
      const armSilence = () => {
        window.clearTimeout(silenceId);
        silenceId = window.setTimeout(() => finish(undefined, heard), SILENCE_MS);
      };
      rec.onresult = (ev) => {
        let session = "";
        let interim = "";
        for (let i = 0; i < ev.results.length; i++) {
          const piece = ev.results[i]?.[0]?.transcript || "";
          if (ev.results[i]?.isFinal) session += piece;
          else interim += piece;
        }
        heard = [prefix, session.trim(), interim.trim()].filter(Boolean).join(" ");
        armSilence();
      };
      rec.onerror = (ev) => {
        if (ev.error === "aborted" || ev.error === "no-speech") return;
        finish(new Error(ev.error || "Speech recognition failed"));
      };
      rec.onend = () => {
        if (done) return;
        prefix = heard;
        if (this.cancelled) {
          finish(undefined, heard);
          return;
        }
        try {
          rec.start();
        } catch {
          finish(undefined, heard);
        }
      };
      armSilence();
      rec.start();
    });
  }

  private async listenBrowserLive(stream: MediaStream, handlers: LiveHandlers): Promise<string> {
    stream.getTracks().forEach((t) => t.stop());
    return this.listenBrowser();
  }

  private async listenCloud(): Promise<string> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("Microphone not available. Allow mic for Obsidian.");
    }
    const mime = pickMime();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.cancelled) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Empty transcript");
    }
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    this.rec = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const blob = await new Promise<Blob>((resolve, reject) => {
      rec.onerror = () => reject(new Error("Recording failed"));
      rec.onstop = () => {
        this.unvad = null;
        stream.getTracks().forEach((t) => t.stop());
        this.rec = null;
        resolve(new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }));
      };
      rec.start(200);
      this.unvad = watchSilence(stream, () => {
        try {
          if (rec.state !== "inactive") rec.stop();
        } catch {
          /* ignore */
        }
      });
    });
    if (!blob.size) throw new Error("Empty recording");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ext = (blob.type || "").includes("mp4") ? "m4a" : "webm";
    return this.transcribeBytes(bytes, `speech.${ext}`, blob.type || "audio/webm");
  }

  async transcribeBytes(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
    const kind = this.settings().sttProvider;
    if (kind === "whisper") return this.transcribeWhisper(bytes, filename, mime);
    if (kind === "mistral") return this.transcribeMistral(bytes, filename, mime);
    if (kind === "openai") return this.transcribeOpenai(bytes, filename, mime);
    if (kind === "google") return this.transcribeGoogle(bytes, filename, mime);
    return this.transcribeGrok(bytes, filename, mime);
  }

  private async transcribeGrok(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
    return this.postStt(`${API}/stt`, { language: "en", format: "true" }, bytes, filename, mime, {
      Authorization: "Bearer " + (await this.key()),
    });
  }

  private async transcribeWhisper(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
    const root = openaiRoot(this.settings().whisperUrl || DEFAULT_WHISPER_URL);
    return this.postStt(`${root}/audio/transcriptions`, { model: "whisper-1", language: "en" }, bytes, filename, mime);
  }

  private async transcribeMistral(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
    return this.postStt(
      `${MISTRAL_API}/audio/transcriptions`,
      { model: "voxtral-mini-latest", language: "en" },
      bytes,
      filename,
      mime,
      { Authorization: "Bearer " + (await this.mistralKey()) }
    );
  }

  private async transcribeOpenai(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
    return this.postStt(
      "https://api.openai.com/v1/audio/transcriptions",
      { model: "whisper-1", language: "en" },
      bytes,
      filename,
      mime,
      { Authorization: "Bearer " + (await this.openaiKey()) }
    );
  }

  private async transcribeGoogle(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
    const key = await this.googleKey();
    const res = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: "Transcribe this speech. Return only the transcript." },
              { inline_data: { mime_type: mime || "audio/webm", data: b64enc(bytes) } },
            ],
          },
        ],
      }),
      throw: false,
    });
    if (res.status >= 300) throw new Error(`STT ${res.status}: ${(res.text || "").slice(0, 180)}`);
    const json = parseJson(res);
    const cands = json.candidates;
    const first: unknown = Array.isArray(cands) ? cands[0] : null;
    const parts: { text?: string }[] = [];
    if (first && typeof first === "object" && "content" in first) {
      const content = (first as { content?: { parts?: unknown } }).content;
      if (Array.isArray(content?.parts)) {
        for (const part of content.parts) {
          if (part && typeof part === "object") parts.push(part as { text?: string });
        }
      }
    }
    const text = (parts || []).map((p) => p.text || "").join("").trim();
    if (!text) throw new Error("Empty transcript");
    return text;
  }

  private async postStt(
    url: string,
    fields: Record<string, string>,
    bytes: Uint8Array,
    filename: string,
    mime: string,
    headers: Record<string, string> = {}
  ): Promise<string> {
    const { boundary, body } = multipart(fields, filename, bytes, mime || "application/octet-stream");
    let res;
    try {
      res = await requestUrl({
        url,
        method: "POST",
        headers: { ...headers, "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        throw: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(msg.includes("net") || /network/i.test(msg) ? `STT could not reach ${url}` : msg);
    }
    if (res.status >= 300) throw new Error(`STT ${res.status}: ${(res.text || "").slice(0, 180)}`);
    const json = parseJson(res);
    const text = (txt(json.text) || txt(json.transcription)).trim();
    if (!text) throw new Error("Empty transcript");
    return text;
  }

  async speak(text: string): Promise<void> {
    const t = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[#*_~>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1600);
    if (!t) return;
    this.cancelSpeak();
    const kind = this.settings().ttsProvider;
    if (kind === "kokoro") return this.speakKokoro(t);
    if (kind === "mistral") return this.speakMistral(t);
    return this.speakBrowser(t);
  }

  private speakBrowser(t: string): Promise<void> {
    if (!window.speechSynthesis) throw new Error("This computer has no speech synthesis.");
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(t);
      u.lang = "en-US";
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }

  private async speakKokoro(t: string): Promise<void> {
    const root = openaiRoot(this.settings().kokoroUrl || DEFAULT_KOKORO_URL);
    const voice = this.settings().kokoroVoice || "af_heart";
    const res = await requestUrl({
      url: `${root}/audio/speech`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kokoro", input: t, voice, response_format: "mp3" }),
      throw: false,
    });
    if (res.status >= 300) throw new Error(`TTS ${res.status}: ${(res.text || "").slice(0, 180)}`);
    await this.playBytes(res.arrayBuffer, "audio/mpeg");
  }

  private async speakMistral(t: string): Promise<void> {
    const res = await requestUrl({
      url: `${MISTRAL_API}/audio/speech`,
      method: "POST",
      headers: {
        Authorization: "Bearer " + (await this.mistralKey()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "voxtral-mini-tts-2603",
        input: t,
        voice_id: this.settings().mistralVoice || "gb_jane_neutral",
        response_format: "mp3",
        stream: false,
      }),
      throw: false,
    });
    if (res.status >= 300) throw new Error(`TTS ${res.status}: ${(res.text || "").slice(0, 180)}`);
    const json = parseJson(res);
    const b64 = txt(json.audio_data);
    if (b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      await this.playBytes(out.buffer, "audio/mpeg");
      return;
    }
    await this.playBytes(res.arrayBuffer, "audio/mpeg");
  }

  private playBytes(buf: ArrayBuffer, mime: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: mime }));
      const audio = new Audio(url);
      this.audio = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (this.audio === audio) this.audio = null;
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (this.audio === audio) this.audio = null;
        reject(new Error("Could not play speech"));
      };
      void audio.play().catch(reject);
    });
  }
}
