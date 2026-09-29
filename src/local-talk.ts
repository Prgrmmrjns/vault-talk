import type { ChatMsg, VaultAgent } from "./agent";
import { VoiceIO } from "./audio";
import type { VoiceHandlers, VoicePhase } from "./grok-voice";
import type { LMVoiceSettings } from "./settings";

export class LocalTalkSession {
  live = false;
  micOn = false;
  phase: VoicePhase = "idle";
  private history: ChatMsg[] = [];
  private n = 0;
  private looping = false;
  private voice: VoiceIO;

  constructor(
    private agent: VaultAgent,
    private settings: () => LMVoiceSettings,
    xaiKey: () => Promise<string>,
    mistralKey: () => Promise<string>,
    openaiKey: () => Promise<string> = async () => "",
    googleKey: () => Promise<string> = async () => "",
    private handlers: VoiceHandlers
  ) {
    this.voice = new VoiceIO(settings, xaiKey, mistralKey, openaiKey, googleKey);
  }

  async start(mic: boolean) {
    if (this.live && mic && !this.micOn) {
      this.micOn = true;
      void this.loop();
      return;
    }
    if (this.live) return;
    this.live = true;
    this.micOn = mic;
    this.handlers.onSession("local");
    this.setPhase(mic ? "listening" : "idle");
    if (mic) void this.loop();
  }

  async stop() {
    this.live = false;
    this.micOn = false;
    this.voice.cancelListen();
    this.voice.stopListen();
    this.voice.cancelSpeak();
    this.setPhase("idle");
  }

  async pushContext() {}

  async sendText(text: string) {
    const t = text.trim();
    if (!t) return;
    if (!this.live) await this.start(false);
    this.voice.cancelListen();
    const mic = this.micOn;
    this.micOn = false;
    await this.turn(t);
    this.micOn = mic;
    if (this.live && this.micOn) {
      this.setPhase("listening");
      void this.loop();
    } else if (this.live && !this.micOn) await this.stop();
  }

  private setPhase(p: VoicePhase) {
    if (this.phase === p) return;
    this.phase = p;
    this.handlers.onPhase(p);
  }

  private async loop() {
    if (this.looping) return;
    this.looping = true;
    try {
      while (this.live && this.micOn) {
        this.setPhase("listening");
        try {
          const heard = await this.voice.listenTurn();
          if (!this.live || !this.micOn) return;
          await this.turn(heard);
        } catch (err) {
          if (!this.live) return;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg !== "Empty transcript" && msg !== "Cancelled") this.handlers.onError(msg);
        }
      }
    } finally {
      this.looping = false;
    }
  }

  private async turn(user: string) {
    const id = `u${++this.n}`;
    this.handlers.onUser(id, user);
    this.history.push({ role: "user", content: user });
    this.setPhase("thinking");
    this.handlers.onAssistant("…", false);
    const reply = await this.agent.run(this.history, (name, detail) => this.handlers.onTool(name, detail));
    this.handlers.onAssistant(reply || "(no reply)", true);
    this.history.push({ role: "assistant", content: reply });
    if (this.history.length > 24) this.history = this.history.slice(-24);
    if (!reply || !this.settings().speakReplies) return;
    this.setPhase("speaking");
    await this.voice.speak(reply);
  }
}
