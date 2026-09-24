import { requestUrl } from "obsidian";
import type { VaultAgent } from "./agent";
import { parseJson } from "./providers";
import type { LMVoiceSettings } from "./settings";
import { VoiceLogger, voiceSessionId } from "./voice-log";

export type VoicePhase = "idle" | "connecting" | "listening" | "thinking" | "speaking";

export type VoiceHandlers = {
  onPhase: (p: VoicePhase) => void;
  onUser: (itemId: string, text: string) => void;
  onAssistant: (text: string, done: boolean) => void;
  onTool: (name: string, detail: string) => void;
  onError: (msg: string) => void;
  onSession: (id: string) => void;
};

const WS_URL = "wss://api.x.ai/v1/realtime?model=grok-voice-latest";
const TARGET = 24000;
const WORKLET = `class VtCap extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c&&c.length)this.port.postMessage(c.slice());return true}}registerProcessor("vt-cap",VtCap);`;

function b64enc(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64dec(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = to / from;
  const n = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / ratio;
    const i0 = Math.min(Math.floor(x), input.length - 1);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = x - i0;
    out[i] = (input[i0] ?? 0) * (1 - f) + (input[i1] ?? 0) * f;
  }
  return out;
}

function toPcm16(f32: Float32Array): Uint8Array {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i] ?? 0));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

function fromPcm16(bytes: Uint8Array): Float32Array {
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 32768;
  return out;
}

class PcmPlayer {
  private next = 0;
  private nodes: AudioBufferSourceNode[] = [];
  underruns = 0;
  drainMs = 0;
  queuedMs = 0;

  constructor(private ctx: AudioContext) {}

  reset() {
    this.next = this.ctx.currentTime + 0.15;
    this.underruns = 0;
    this.drainMs = 0;
    this.queuedMs = 0;
  }

  push(f32: Float32Array) {
    if (!f32.length) return;
    const buf = this.ctx.createBuffer(1, f32.length, this.ctx.sampleRate);
    buf.copyToChannel(f32 as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.next < now) {
      this.underruns++;
      this.next = now + 0.02;
    }
    const start = this.next;
    src.start(start);
    this.next = start + buf.duration;
    this.queuedMs = Math.max(0, (this.next - now) * 1000);
    this.drainMs = Math.max(this.drainMs, this.queuedMs);
    this.nodes.push(src);
    src.onended = () => {
      this.nodes = this.nodes.filter((n) => n !== src);
    };
  }

  stop(): number {
    const dropped = Math.max(0, (this.next - this.ctx.currentTime) * 1000);
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
      n.disconnect();
    }
    this.nodes = [];
    this.next = 0;
    this.queuedMs = 0;
    return dropped;
  }
}

export class GrokVoiceSession {
  live = false;
  micOn = false;
  phase: VoicePhase = "idle";
  sessionId = "";
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private uncap: (() => void) | null = null;
  private player: PcmPlayer | null = null;
  private log: VoiceLogger | null = null;
  private pending: Uint8Array[] = [];
  private open = false;
  private assistant = "";
  /** Final reply for this response was already shown. Transcript-done and response-done both fire. */
  private spoke = false;
  private fnWait = 0;
  private fnNeed = false;
  private inRms: number[] = [];
  private inChunks = 0;
  private inBytes = 0;
  private inTimer = 0;
  private outBytes = 0;
  private outDeltas = 0;
  private outFirst = false;
  private createdT = 0;
  private speechStoppedT = 0;
  private responseId = "";
  private wall0 = 0;

  constructor(
    private getKey: () => Promise<string>,
    private agent: VaultAgent,
    private settings: () => LMVoiceSettings,
    private logDir: string,
    private handlers: VoiceHandlers
  ) {}

  private setPhase(p: VoicePhase) {
    if (this.phase === p) return;
    this.phase = p;
    this.log?.log("phase", { phase: p });
    this.handlers.onPhase(p);
  }

  async start(mic: boolean) {
    if (this.live) {
      if (mic && !this.micOn) await this.enableMic();
      return;
    }
    this.live = true;
    this.sessionId = voiceSessionId();
    this.log = new VoiceLogger(this.sessionId, this.logDir);
    this.handlers.onSession(this.sessionId);
    this.setPhase("connecting");
    this.log.log("start", { url: WS_URL, target_rate: TARGET });
    const t0 = Date.now();
    try {
      const token = await this.token();
      this.log.log("token.ok", { ms: Date.now() - t0 });
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ sampleRate: TARGET });
      await this.ctx.resume();
      this.player = new PcmPlayer(this.ctx);
      if (mic) await this.enableMic();
      this.log.log("env", {
        ua: navigator.userAgent,
        mic_rate: this.ctx.sampleRate,
        mic_state: this.ctx.state,
        play_rate: this.ctx.sampleRate,
        play_state: this.ctx.state,
        target_rate: TARGET,
      });
      await this.connect(token);
    } catch (err) {
      this.log?.error("start", err);
      this.handlers.onError(this.errMsg(err));
      await this.stop("error");
    }
  }

  async sendText(text: string) {
    const t = text.trim();
    if (!t) return;
    if (!this.live) await this.start(false);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Voice not connected");
    this.assistant = "";
    this.spoke = false;
    this.setPhase("thinking");
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] },
    });
    this.send({ type: "response.create" });
  }

  async stop(by = "client") {
    if (!this.live && !this.ws) return;
    this.log?.log("stop", { by, phase: this.phase });
    this.live = false;
    this.micOn = false;
    this.open = false;
    this.uncap?.();
    this.uncap = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.player?.stop();
    this.player = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.pending = [];
    this.log?.close();
    this.log = null;
    this.setPhase("idle");
  }

  private errMsg(err: unknown): string {
    const m = err instanceof Error ? err.message : String(err);
    return this.sessionId ? `${m} (voice session ${this.sessionId})` : m;
  }

  private async token(): Promise<string> {
    const key = await this.getKey();
    const t0 = Date.now();
    const res = await requestUrl({
      url: "https://api.x.ai/v1/realtime/client_secrets",
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { seconds: 3600 } }),
      throw: false,
    });
    this.log?.log("server.token", { ok: res.status < 300, status: res.status, ms: Date.now() - t0, upstream: "client_secrets" });
    if (res.status >= 300) throw new Error(`xAI token ${res.status}: ${(res.text || "").slice(0, 160)}`);
    const json = parseJson(res);
    const value = String(json.value || json.client_secret || "");
    if (!value) throw new Error("Empty xAI ephemeral token");
    return value;
  }

  private async enableMic() {
    if (!this.ctx) throw new Error("Audio not ready");
    const t0 = Date.now();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      const track = this.stream.getAudioTracks()[0];
      this.log?.log("mic.ok", { ms: Date.now() - t0, label: track?.label, settings: track?.getSettings?.() });
    } catch (err) {
      this.log?.error("mic", err, { ms: Date.now() - t0 });
      throw new Error("Microphone not available. Allow mic for Obsidian.");
    }
    this.micOn = true;
    this.uncap = await this.capture(this.ctx, this.stream);
  }

  private async capture(ctx: AudioContext, stream: MediaStream): Promise<() => void> {
    const src = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const acc: Float32Array[] = [];
    let accN = 0;
    const want = Math.floor(ctx.sampleRate * 0.1);
    const flush = () => {
      if (!accN) return;
      const merged = new Float32Array(accN);
      let o = 0;
      for (const a of acc) {
        merged.set(a, o);
        o += a.length;
      }
      acc.length = 0;
      accN = 0;
      const pcm = toPcm16(resample(merged, ctx.sampleRate, TARGET));
      this.pushIn(pcm);
    };
    const onF32 = (chunk: Float32Array) => {
      acc.push(chunk);
      accN += chunk.length;
      if (accN >= want) flush();
    };
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, "vt-cap");
      node.port.onmessage = (e) => onF32(e.data as Float32Array);
      src.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      return () => {
        flush();
        node.port.onmessage = null;
        node.disconnect();
        src.disconnect();
        mute.disconnect();
      };
    } catch {
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (e) => onF32(e.inputBuffer.getChannelData(0).slice());
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      return () => {
        flush();
        proc.disconnect();
        src.disconnect();
        mute.disconnect();
      };
    }
  }

  private pushIn(pcm: Uint8Array) {
    let sum = 0;
    const s16 = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    for (let i = 0; i < s16.length; i++) {
      const v = (s16[i] ?? 0) / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, s16.length));
    this.inRms.push(rms);
    this.inChunks++;
    this.inBytes += pcm.byteLength;
    if (!this.inTimer) this.inTimer = window.setTimeout(() => this.flushInStats(), 2000);
    if (!this.open) {
      this.pending.push(pcm);
      return;
    }
    this.sendAudio(pcm);
  }

  private flushInStats() {
    this.inTimer = 0;
    if (!this.inChunks) return;
    const rms = this.inRms;
    const avg = rms.reduce((a, b) => a + b, 0) / Math.max(1, rms.length);
    const max = rms.reduce((a, b) => Math.max(a, b), 0);
    this.log?.log("audio.in", {
      chunks: this.inChunks,
      bytes: this.inBytes,
      rms_max: max,
      rms_avg: avg,
      pending: this.pending.length,
      mic_state: this.ctx?.state,
      phase: this.phase,
    });
    this.inChunks = 0;
    this.inBytes = 0;
    this.inRms = [];
  }

  private sendAudio(pcm: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64enc(pcm) }));
  }

  private async connect(token: string) {
    this.log?.log("ws.connecting", {});
    const t0 = Date.now();
    const ws = new WebSocket(WS_URL, [`xai-client-secret.${token}`]);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.open = true;
      this.log?.log("ws.open", { ms: Date.now() - t0 });
      void this.configure();
      if (this.pending.length) this.log?.log("audio.flush", { chunks: this.pending.length });
      for (const p of this.pending) this.sendAudio(p);
      this.pending = [];
      this.setPhase(this.micOn ? "listening" : "listening");
    };
    ws.onerror = () => {
      this.log?.log("ws.error", {});
    };
    ws.onclose = (ev) => {
      this.log?.log("ws.close", { code: ev.code, reason: String(ev.reason || "").slice(0, 200), wasClean: ev.wasClean, by: this.live ? "server" : "client" });
      if (this.live) {
        this.handlers.onError(this.errMsg(new Error(`Voice closed (${ev.code})`)));
        void this.stop("server");
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        if (ev.data instanceof ArrayBuffer) this.playBytes(new Uint8Array(ev.data));
        return;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      void this.onEvent(event);
    };
  }

  private async configure() {
    const s = this.settings();
    const tools: unknown[] = this.agent.grokTools();
    if (s.allowInternet) tools.push({ type: "web_search" });
    this.send({
      type: "session.update",
      session: {
        voice: s.grokVoice || "eve",
        instructions: await this.agent.systemText(),
        turn_detection: { type: "server_vad" },
        reasoning: { effort: "none" },
        tools,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: TARGET },
            transcription: { model: "grok-transcribe", language_hint: "en" },
          },
          output: { format: { type: "audio/pcm", rate: TARGET } },
        },
      },
    });
  }

  private send(event: Record<string, unknown>) {
    this.log?.client(event);
    this.ws?.send(JSON.stringify(event));
  }

  private playBytes(bytes: Uint8Array) {
    if (!this.ctx || !this.player) return;
    this.outDeltas++;
    this.outBytes += bytes.byteLength;
    if (!this.outFirst) {
      this.outFirst = true;
      this.log?.log("audio.out.first", {
        response_id: this.responseId,
        bytes: bytes.byteLength,
        since_response_created_ms: this.createdT ? Date.now() - this.createdT : 0,
        since_speech_stopped_ms: this.speechStoppedT ? Date.now() - this.speechStoppedT : 0,
        play_state: this.ctx.state,
      });
      this.player.reset();
      this.setPhase("speaking");
    }
    const f24 = fromPcm16(bytes);
    this.player.push(resample(f24, TARGET, this.ctx.sampleRate));
  }

  private bargeIn() {
    const dropped = this.player?.stop() ?? 0;
    this.log?.log("play.stop", { reason: "speech_started", dropped_ms: dropped });
    this.outFirst = false;
    if (this.micOn) this.setPhase("listening");
  }

  private maybeContinue() {
    if (!this.fnNeed || this.fnWait > 0 || !this.open) return;
    this.fnNeed = false;
    this.send({ type: "response.create" });
  }

  private finishAssistant(text: string) {
    if (this.spoke || !text) return;
    this.spoke = true;
    this.handlers.onAssistant(text, true);
  }

  private async onEvent(event: Record<string, unknown>) {
    const type = String(event.type || "");
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      const delta = String(event.delta || event.audio || "");
      if (delta) this.playBytes(b64dec(delta));
      return;
    }
    this.log?.server(event, { phase: this.phase });
    if (type === "input_audio_buffer.speech_started") {
      this.bargeIn();
      this.setPhase("listening");
    } else if (type === "input_audio_buffer.speech_stopped") {
      this.speechStoppedT = Date.now();
      this.setPhase("thinking");
    } else if (type === "input_audio_buffer.committed") {
      this.handlers.onUser(String(event.item_id || event.itemId || ""), "");
    } else if (type === "conversation.item.input_audio_transcription.updated") {
      const text = String(event.transcript || event.text || "");
      const id = String(event.item_id || "");
      if (text) this.handlers.onUser(id, text);
    } else if (type === "response.created") {
      this.createdT = Date.now();
      this.wall0 = Date.now();
      this.outBytes = 0;
      this.outDeltas = 0;
      this.outFirst = false;
      this.responseId = String(event.response && typeof event.response === "object" && "id" in event.response ? (event.response as { id?: string }).id : event.id || "");
      this.assistant = "";
      this.spoke = false;
      this.player?.reset();
    } else if (type === "response.output_audio_transcript.delta") {
      this.assistant += String(event.delta || "");
      this.handlers.onAssistant(this.assistant, false);
      if (!this.outFirst) this.setPhase("thinking");
    } else if (type === "response.output_audio_transcript.done") {
      const t = String(event.transcript || this.assistant);
      this.assistant = t;
      this.finishAssistant(t);
    } else if (type === "response.function_call_arguments.done") {
      await this.onFn(event);
    } else if (type === "response.done") {
      const audioMs = this.outBytes ? (this.outBytes / 2 / TARGET) * 1000 : 0;
      this.log?.log("audio.out", {
        response_id: this.responseId,
        status: event.status || (event.response as { status?: string } | undefined)?.status,
        deltas: this.outDeltas,
        bytes: this.outBytes,
        audio_ms: audioMs,
        wall_ms: Date.now() - (this.wall0 || Date.now()),
        queued_ms: this.player?.queuedMs ?? 0,
        underruns: this.player?.underruns ?? 0,
        drain_ms_max: this.player?.drainMs ?? 0,
      });
      if (this.assistant) this.finishAssistant(this.assistant);
      this.maybeContinue();
      if (!this.fnNeed && this.micOn && this.live) this.setPhase("listening");
      else if (!this.fnNeed && this.live && !this.micOn) this.setPhase("listening");
    } else if (type === "error") {
      const msg = String((event.error as { message?: string } | undefined)?.message || event.message || "Voice error");
      this.handlers.onError(this.errMsg(new Error(msg)));
    }
  }

  private async onFn(event: Record<string, unknown>) {
    const name = String(event.name || "");
    const callId = String(event.call_id || "");
    const args = String(event.arguments || "{}");
    this.fnNeed = true;
    this.fnWait++;
    this.setPhase("thinking");
    this.handlers.onTool(name, "running");
    try {
      const out = await this.agent.callTool(name, args, (n, d) => this.handlers.onTool(n, d));
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: out },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.handlers.onTool(name, msg);
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: `Error: ${msg}` },
      });
    } finally {
      this.fnWait--;
      this.maybeContinue();
    }
  }
}
