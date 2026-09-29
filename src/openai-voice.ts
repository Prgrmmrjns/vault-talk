import { requestUrl } from "obsidian";
import type { VaultAgent } from "./agent";
import { parseJson } from "./providers";
import type { LMVoiceSettings } from "./settings";
import { VoiceLogger, voiceSessionId } from "./voice-log";
import type { VoiceHandlers, VoicePhase } from "./grok-voice";
import { txt } from "./txt";
import {
  PcmPlayer,
  RATE_24K,
  attachCapture,
  audioCtx,
  b64dec,
  b64enc,
  fromPcm16,
  openMic,
  resample,
} from "./voice-pcm";

const MODEL = "gpt-realtime-2.1";
const WS_URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;
const TARGET = RATE_24K;

export class OpenaiVoiceSession {
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
      this.ctx = audioCtx(TARGET);
      await this.ctx.resume();
      this.player = new PcmPlayer(this.ctx);
      if (mic) await this.enableMic();
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

  private secretFrom(json: Record<string, unknown>): string {
    if (typeof json.value === "string" && json.value) return json.value;
    const cs = json.client_secret;
    if (typeof cs === "string" && cs) return cs;
    if (cs && typeof cs === "object" && "value" in cs) return String((cs as { value?: string }).value || "");
    return "";
  }

  private async token(): Promise<string> {
    const key = await this.getKey();
    const t0 = Date.now();
    const res = await requestUrl({
      url: "https://api.openai.com/v1/realtime/client_secrets",
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { seconds: 3600 },
        session: { type: "realtime", model: MODEL },
      }),
      throw: false,
    });
    this.log?.log("server.token", { ok: res.status < 300, status: res.status, ms: Date.now() - t0 });
    if (res.status < 300) {
      const value = this.secretFrom(parseJson(res));
      if (value) return value;
    }
    this.log?.log("server.token.fallback", { status: res.status });
    return key;
  }

  private async enableMic() {
    if (!this.ctx) throw new Error("Audio not ready");
    const t0 = Date.now();
    try {
      this.stream = await openMic();
      const track = this.stream.getAudioTracks()[0];
      this.log?.log("mic.ok", { ms: Date.now() - t0, label: track?.label });
    } catch (err) {
      this.log?.error("mic", err, { ms: Date.now() - t0 });
      throw new Error("Microphone not available. Allow mic for Obsidian.");
    }
    this.micOn = true;
    this.uncap = await attachCapture(this.ctx, this.stream, (pcm) => this.pushIn(pcm), TARGET);
  }

  private pushIn(pcm: Uint8Array) {
    let sum = 0;
    const s16 = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    for (let i = 0; i < s16.length; i++) {
      const v = (s16[i] ?? 0) / 32768;
      sum += v * v;
    }
    this.inRms.push(Math.sqrt(sum / Math.max(1, s16.length)));
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
    this.log?.log("audio.in", { chunks: this.inChunks, bytes: this.inBytes, pending: this.pending.length, phase: this.phase });
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
    const ws = new WebSocket(WS_URL, ["realtime", `openai-insecure-api-key.${token}`]);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.open = true;
      this.log?.log("ws.open", { ms: Date.now() - t0 });
      void this.configure();
      for (const p of this.pending) this.sendAudio(p);
      this.pending = [];
      this.setPhase("listening");
    };
    ws.onerror = () => this.log?.log("ws.error", {});
    ws.onclose = (ev) => {
      this.log?.log("ws.close", { code: ev.code, reason: String(ev.reason || "").slice(0, 200), wasClean: ev.wasClean });
      if (this.live) {
        this.handlers.onError(this.errMsg(new Error(`ChatGPT Voice closed (${ev.code})`)));
        void this.stop("server");
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
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
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: MODEL,
        instructions: await this.agent.systemText(),
        output_modalities: ["audio"],
        tools: this.agent.grokTools(),
        audio: {
          input: {
            format: { type: "audio/pcm", rate: TARGET },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: { type: "server_vad" },
          },
          output: {
            voice: s.openaiVoice || "marin",
            format: { type: "audio/pcm", rate: TARGET },
          },
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
      this.player.reset();
      this.setPhase("speaking");
    }
    this.player.push(resample(fromPcm16(bytes), TARGET, this.ctx.sampleRate));
  }

  private bargeIn() {
    this.player?.stop();
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
    const type = txt(event.type);
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      const delta = txt(event.delta) || txt(event.audio);
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
      this.handlers.onUser(txt(event.item_id), "");
    } else if (
      type === "conversation.item.input_audio_transcription.updated" ||
      type === "conversation.item.input_audio_transcription.delta" ||
      type === "conversation.item.input_audio_transcription.completed"
    ) {
      const text = txt(event.transcript) || txt(event.delta) || txt(event.text);
      const id = txt(event.item_id);
      if (text) this.handlers.onUser(id, text);
    } else if (type === "response.created") {
      this.createdT = Date.now();
      this.wall0 = Date.now();
      this.outBytes = 0;
      this.outDeltas = 0;
      this.outFirst = false;
      const rid =
        event.response && typeof event.response === "object" && "id" in event.response
          ? (event.response as { id?: unknown }).id
          : event.id;
      this.responseId = txt(rid);
      this.assistant = "";
      this.spoke = false;
      this.player?.reset();
    } else if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
      this.assistant += txt(event.delta);
      this.handlers.onAssistant(this.assistant, false);
      if (!this.outFirst) this.setPhase("thinking");
    } else if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      const t = txt(event.transcript) || this.assistant;
      this.assistant = t;
      this.finishAssistant(t);
    } else if (type === "response.function_call_arguments.done") {
      await this.onFn(event);
    } else if (type === "response.done") {
      if (this.assistant) this.finishAssistant(this.assistant);
      this.maybeContinue();
      if (!this.fnNeed && this.live) this.setPhase("listening");
    } else if (type === "error") {
      const errObj = event.error as { message?: unknown } | undefined;
      const msg = txt(errObj?.message) || txt(event.message) || "Voice error";
      this.handlers.onError(this.errMsg(new Error(msg)));
    }
  }

  private async onFn(event: Record<string, unknown>) {
    const name = txt(event.name);
    const callId = txt(event.call_id);
    const args = txt(event.arguments) || "{}";
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
