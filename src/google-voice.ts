import type { VaultAgent } from "./agent";
import type { VoiceHandlers, VoicePhase } from "./grok-voice";
import type { LMVoiceSettings } from "./settings";
import { VoiceLogger, voiceSessionId } from "./voice-log";
import {
  PcmPlayer,
  RATE_16K,
  RATE_24K,
  attachCapture,
  audioCtx,
  b64dec,
  b64enc,
  fromPcm16,
  openMic,
  resample,
} from "./voice-pcm";

const MODEL = "models/gemini-3.1-flash-live-preview";
const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const IN_RATE = RATE_16K;
const OUT_RATE = RATE_24K;

type FnCall = { id?: string; name?: string; args?: unknown };

export class GoogleVoiceSession {
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
  private userN = 0;
  private outFirst = false;

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
    try {
      const key = await this.getKey();
      this.ctx = audioCtx(OUT_RATE);
      await this.ctx.resume();
      this.player = new PcmPlayer(this.ctx);
      if (mic) await this.enableMic();
      await this.connect(key);
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
    this.send({ realtimeInput: { text: t } });
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

  private async enableMic() {
    if (!this.ctx) throw new Error("Audio not ready");
    try {
      this.stream = await openMic();
    } catch {
      throw new Error("Microphone not available. Allow mic for Obsidian.");
    }
    this.micOn = true;
    this.uncap = await attachCapture(this.ctx, this.stream, (pcm) => this.pushIn(pcm), IN_RATE);
  }

  private pushIn(pcm: Uint8Array) {
    if (!this.open) {
      this.pending.push(pcm);
      return;
    }
    this.sendAudio(pcm);
  }

  private sendAudio(pcm: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({
      realtimeInput: {
        audio: { data: b64enc(pcm), mimeType: `audio/pcm;rate=${IN_RATE}` },
      },
    });
  }

  private async connect(key: string) {
    const t0 = Date.now();
    const ws = new WebSocket(`${WS_BASE}?key=${encodeURIComponent(key)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.log?.log("ws.open", { ms: Date.now() - t0 });
      void this.configure();
    };
    ws.onerror = () => this.log?.log("ws.error", {});
    ws.onclose = (ev) => {
      this.log?.log("ws.close", { code: ev.code, reason: String(ev.reason || "").slice(0, 200) });
      if (this.live) {
        this.handlers.onError(this.errMsg(new Error(`Google Voice closed (${ev.code})`)));
        void this.stop("server");
      }
    };
    ws.onmessage = (ev) => void this.onRaw(ev.data);
  }

  private async onRaw(data: unknown) {
    let text = "";
    if (typeof data === "string") text = data;
    else if (data instanceof Blob) text = await data.text();
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    void this.onEvent(event);
  }

  private async configure() {
    const s = this.settings();
    const tools = this.agent.grokTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    this.send({
      setup: {
        model: MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: s.googleVoice || "Kore" } },
          },
        },
        systemInstruction: { parts: [{ text: await this.agent.systemText() }] },
        tools: tools.length ? [{ functionDeclarations: tools }] : undefined,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  }

  private send(event: Record<string, unknown>) {
    this.log?.client(event);
    this.ws?.send(JSON.stringify(event));
  }

  private playBytes(bytes: Uint8Array) {
    if (!this.ctx || !this.player) return;
    if (!this.outFirst) {
      this.outFirst = true;
      this.player.reset();
      this.setPhase("speaking");
    }
    this.player.push(resample(fromPcm16(bytes), OUT_RATE, this.ctx.sampleRate));
  }

  private bargeIn() {
    this.player?.stop();
    this.outFirst = false;
    if (this.micOn) this.setPhase("listening");
  }

  private finishAssistant(text: string) {
    if (this.spoke || !text) return;
    this.spoke = true;
    this.handlers.onAssistant(text, true);
  }

  private async onEvent(event: Record<string, unknown>) {
    this.log?.server(event, { phase: this.phase });
    if (event.setupComplete) {
      for (const p of this.pending) this.sendAudio(p);
      this.pending = [];
      this.setPhase("listening");
      return;
    }
    const err = event.error as { message?: string } | undefined;
    if (err?.message) {
      this.handlers.onError(this.errMsg(new Error(err.message)));
      return;
    }
    const toolCall = event.toolCall as { functionCalls?: FnCall[] } | undefined;
    if (toolCall?.functionCalls?.length) {
      await this.onFns(toolCall.functionCalls);
      return;
    }
    const sc = event.serverContent as Record<string, unknown> | undefined;
    if (!sc) return;
    if (sc.interrupted) this.bargeIn();
    const inT = sc.inputTranscription as { text?: string } | undefined;
    const inI = sc.interimInputTranscription as { text?: string } | undefined;
    const heard = String(inT?.text || inI?.text || "");
    if (heard) this.handlers.onUser(`g${this.userN || 1}`, heard);
    const outT = sc.outputTranscription as { text?: string } | undefined;
    if (outT?.text) {
      this.assistant = this.assistant && outT.text.startsWith(this.assistant) ? outT.text : this.assistant + outT.text;
      this.handlers.onAssistant(this.assistant, false);
    }
    const turn = sc.modelTurn as { parts?: { inlineData?: { data?: string; mimeType?: string }; text?: string }[] } | undefined;
    for (const part of turn?.parts || []) {
      if (part.inlineData?.data) this.playBytes(b64dec(part.inlineData.data));
      if (part.text) {
        this.assistant += part.text;
        this.handlers.onAssistant(this.assistant, false);
      }
    }
    if (sc.turnComplete) {
      this.finishAssistant(this.assistant);
      this.assistant = "";
      this.spoke = false;
      this.outFirst = false;
      this.userN++;
      if (this.fnWait <= 0 && this.live) this.setPhase("listening");
    } else if (inI?.text && this.phase === "listening") {
      /* still listening */
    } else if (heard && !this.outFirst) {
      this.setPhase("thinking");
    }
  }

  private async onFns(calls: FnCall[]) {
    this.fnWait += calls.length;
    this.setPhase("thinking");
    const responses: { id: string; name: string; response: { result: string } }[] = [];
    for (const c of calls) {
      const name = String(c.name || "");
      const id = String(c.id || name);
      const raw = c.args ?? (c as { arguments?: unknown }).arguments ?? {};
      const args = typeof raw === "string" ? raw : JSON.stringify(raw);
      this.handlers.onTool(name, "running");
      try {
        const out = await this.agent.callTool(name, args, (n, d) => this.handlers.onTool(n, d));
        responses.push({ id, name, response: { result: out } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.handlers.onTool(name, msg);
        responses.push({ id, name, response: { result: `Error: ${msg}` } });
      }
    }
    this.send({ toolResponse: { functionResponses: responses } });
    this.fnWait -= calls.length;
  }
}
