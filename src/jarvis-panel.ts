import { MarkdownRenderChild, Notice, setIcon, type EventRef } from "obsidian";
import { VaultAgent } from "./agent";
import { GrokVoiceSession, type VoiceHandlers, type VoicePhase } from "./grok-voice";
import { GoogleVoiceSession } from "./google-voice";
import { LocalTalkSession } from "./local-talk";
import { OpenaiVoiceSession } from "./openai-voice";
import { isDuplexTalk } from "./providers";
import type LMVoicePlugin from "./main";
import { hotkeyLabel, accentColor } from "./settings";

const PLACE: Record<VoicePhase, string> = {
  idle: "Message Jarvis…",
  connecting: "Connecting…",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

/** Shared Jarvis UI — sidebar leaf or daily-note embed. */
export class JarvisPanel {
  rootEl!: HTMLElement;
  private unsub: (() => void)[] = [];
  private refs: EventRef[] = [];
  private logEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private orbBtn!: HTMLButtonElement;
  private waveEl!: HTMLElement;
  private srEl!: HTMLElement;
  private dictKeyBtn!: HTMLButtonElement;
  private chatKeyBtn!: HTMLButtonElement;
  private chatKbd!: HTMLElement;
  private dictKbd!: HTMLElement;
  private orbLabel!: HTMLElement;
  private session: GrokVoiceSession | OpenaiVoiceSession | GoogleVoiceSession | LocalTalkSession | null = null;
  private talkKind = "";
  private agent: VaultAgent;
  private userRows = new Map<string, HTMLElement>();
  private botEl: HTMLElement | null = null;
  private toolsEl: HTMLDetailsElement | null = null;
  private toolsList: HTMLElement | null = null;
  private toolsSum: HTMLElement | null = null;
  private toolsN = 0;
  private phase: VoicePhase = "idle";
  private sid = "";
  private compact: boolean;

  constructor(
    private plugin: LMVoicePlugin,
    private host: HTMLElement,
    opts?: { compact?: boolean }
  ) {
    this.compact = !!opts?.compact;
    this.agent = new VaultAgent(this.plugin.app, () => this.plugin.settings, this.plugin.agentKeys());
  }

  mount() {
    this.unsub.push(this.plugin.dictate.onChange((e) => e === "state" && this.paintDict()));
    this.refs.push(
      this.plugin.app.workspace.on("active-leaf-change", () => {
        this.agent.rememberFocus();
        void this.safePushContext();
      }),
      this.plugin.app.workspace.on("file-open", () => {
        this.agent.rememberFocus();
        void this.safePushContext();
      }),
      this.plugin.app.workspace.on("layout-change", () => void this.safePushContext())
    );
    this.agent.rememberFocus();
    this.build();
    this.paintDict();
    this.paintKeys();
  }

  showLog() {
    this.rootEl?.addClass("is-open");
    this.logEl?.scrollIntoView({ block: "nearest" });
  }

  paintKeys() {
    const chat = hotkeyLabel(this.plugin.settings.dictateHotkey);
    const note = hotkeyLabel(this.plugin.settings.noteHotkey);
    const accent = this.plugin.settings.accent || "orange";
    this.rootEl?.setAttr("data-accent", accent);
    this.rootEl?.style.setProperty("--lm-accent", accentColor(accent));
    this.chatKbd?.setText(chat || "—");
    this.dictKbd?.setText(note || "—");
    this.chatKeyBtn?.setAttribute("aria-label", chat ? `Chat ${chat}` : "Chat");
    this.dictKeyBtn?.setAttribute("aria-label", note ? `Dictation ${note}. Click in the note, then speak.` : "Dictation");
  }

  /** Move UI into a new host without killing the voice session. */
  reattach(host: HTMLElement) {
    this.host = host;
    host.empty();
    if (this.rootEl) host.appendChild(this.rootEl);
  }

  async destroy(stopVoice = true) {
    for (const u of this.unsub) u();
    this.unsub = [];
    for (const r of this.refs) this.plugin.app.workspace.offref(r);
    this.refs = [];
    if (stopVoice) {
      await this.session?.stop();
      this.session = null;
    }
    this.host.empty();
  }

  async haltVoice() {
    if (!this.session?.live) return;
    await this.session.stop();
    this.session = null;
    this.phase = "idle";
    this.paintSend();
  }

  async toggleVoice() {
    const live = !!this.session?.live;
    if (live) {
      if (!this.session?.micOn) {
        try {
          await this.session!.start(true);
        } catch (err) {
          this.line("err", err instanceof Error ? err.message : String(err));
        }
        this.paintSend();
        return;
      }
      await this.session?.stop();
      this.session = null;
      this.phase = "idle";
      this.paintSend();
      return;
    }
    try {
      await this.ensure(true);
    } catch (err) {
      this.line("err", err instanceof Error ? err.message : String(err));
    }
    this.paintSend();
  }

  focusInput() {
    this.inputEl?.focus();
  }

  private build() {
    this.host.empty();
    const root = this.host.createDiv({ cls: "vt vt-jarvis" });
    if (this.compact) root.addClass("is-embed");
    root.setAttr("data-accent", this.plugin.settings.accent || "orange");
    this.rootEl = root;

    const head = root.createDiv({ cls: "vt-j-head" });
    head.createDiv({ cls: "vt-j-k", text: "Jarvis" });
    const btns = head.createDiv({ cls: "vt-j-hbtns" });
    this.iconBtn(btns, "eraser", "Clear", () => this.clear());
    this.iconBtn(btns, "settings", "Settings", () => {
      const setting = (this.plugin.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } }).setting;
      setting?.open();
      setting?.openTabById(this.plugin.manifest.id);
    });

    this.logEl = root.createDiv({ cls: "vt-j-log" });
    this.line("sys", this.compact ? "Talk or type — on today’s desk." : "Talk or type. Headphones recommended.");

    const stage = root.createDiv({ cls: "vt-j-stage" });
    this.orbBtn = stage.createEl("button", {
      cls: "vt-j-orb",
      attr: { type: "button", "aria-label": "Start voice" },
    });
    this.orbBtn.createDiv({ cls: "vt-j-orb-ring" });
    this.waveEl = this.orbBtn.createDiv({ cls: "vt-j-wave", attr: { "aria-hidden": "true" } });
    for (let i = 0; i < 4; i++) this.waveEl.createDiv({ cls: "vt-j-bar" });
    this.orbBtn.addEventListener("click", () => void this.toggleVoice());
    this.orbLabel = stage.createDiv({ cls: "vt-j-orb-label", text: "Off" });

    const row = root.createDiv({ cls: "vt-j-row" });
    const keys = row.createDiv({ cls: "vt-j-keys" });
    this.chatKeyBtn = keys.createEl("button", {
      cls: "vt-j-key",
      attr: { type: "button", "aria-label": "Chat" },
    });
    this.chatKeyBtn.createSpan({ text: "Chat" });
    this.chatKbd = this.chatKeyBtn.createEl("kbd");
    this.chatKeyBtn.addEventListener("click", () => {
      this.showLog();
      void this.toggleVoice();
    });
    this.dictKeyBtn = keys.createEl("button", {
      cls: "vt-j-key vt-j-dict",
      attr: { type: "button", "aria-label": "Dictation" },
    });
    this.dictKeyBtn.createSpan({ text: "Dictation" });
    this.dictKbd = this.dictKeyBtn.createEl("kbd");
    this.dictKeyBtn.addEventListener("click", () => this.plugin.toggleDictate());
    this.inputEl = row.createEl("textarea", {
      cls: "vt-j-input",
      attr: { rows: this.compact ? "1" : "2", placeholder: PLACE.idle },
    });
    this.sendBtn = row.createEl("button", {
      cls: "vt-j-send",
      attr: { type: "button", "aria-label": "Send" },
    });
    setIcon(this.sendBtn, "send");
    this.sendBtn.addEventListener("click", () => void this.sendText());
    this.inputEl.addEventListener("input", () => this.paintSend());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.sendText();
      }
    });
    this.srEl = row.createEl("span", { cls: "sr-only", attr: { role: "status" } });
    this.paintSend();
  }

  private iconBtn(parent: HTMLElement, icon: string, tip: string, onClick: () => void) {
    const btn = parent.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": tip, title: tip } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private paintDict() {
    const d = this.plugin.dictate;
    const on = d.state !== "off";
    const active = d.state === "active";
    for (const btn of [this.dictKeyBtn]) {
      if (!btn) continue;
      btn.toggleClass("is-on", on);
      btn.toggleClass("is-active", active);
      btn.setAttribute("aria-label", on ? "Stop dictation" : "Dictate into the note");
    }
  }

  private paintSend() {
    const text = this.inputEl?.value.trim() || "";
    const live = !!this.session?.live;
    const phase = live ? this.phase : "idle";
    this.sendBtn.toggleClass("is-hidden", !text);
    this.rootEl.setAttr("data-phase", phase);
    if (live) this.rootEl.addClass("is-open");
    this.chatKeyBtn?.toggleClass("is-on", live);
    if (this.orbBtn) {
      this.orbBtn.className = "vt-j-orb" + (live ? " is-live is-" + this.phase : " is-idle");
      this.orbBtn.setAttribute("aria-label", live ? (this.session?.micOn ? "End voice" : "Start microphone") : "Start voice");
    }
    if (this.orbLabel) {
      this.orbLabel.className = "vt-j-orb-label is-" + phase;
      this.orbLabel.setText(live ? PLACE[this.phase].replace("…", "") : "Off");
    }
    const ph = PLACE[this.phase];
    const extra = this.sid && this.phase !== "idle" ? ` · ${this.sid}` : "";
    this.inputEl.setAttribute("placeholder", ph);
    this.srEl.setText(ph + extra);
  }

  private line(kind: "you" | "bot" | "sys" | "err", text: string): HTMLElement {
    const el = this.logEl.createDiv({ cls: `vt-j-msg is-${kind}` });
    const body = el.createDiv({ cls: "vt-j-msg-text" });
    body.setText(text);
    this.logEl.scrollTop = this.logEl.scrollHeight;
    return body;
  }

  private addTool(name: string, detail: string) {
    if (!this.toolsEl || !this.toolsList || !this.toolsSum) {
      const root = this.logEl.createEl("details", { cls: "vt-j-tools" });
      const summary = root.createEl("summary");
      const list = root.createDiv({ cls: "vt-j-tools-list" });
      const bot = this.logEl.querySelector(".vt-j-msg.is-bot:last-of-type");
      if (bot) this.logEl.insertBefore(root, bot);
      this.toolsEl = root;
      this.toolsList = list;
      this.toolsSum = summary;
      this.toolsN = 0;
    }
    const line = detail ? `${name}: ${detail}` : name;
    const last = this.toolsList.lastElementChild;
    if (last && last.getText().startsWith(`${name}:`) && /running$/i.test(last.getText())) last.setText(line);
    else {
      this.toolsN++;
      this.toolsList.createDiv({ cls: "vt-j-tools-item", text: line });
    }
    this.toolsSum.setText(`${this.toolsN} tool${this.toolsN === 1 ? "" : "s"} · ${name}`);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private clear() {
    this.userRows.clear();
    this.botEl = null;
    this.toolsEl = null;
    this.toolsList = null;
    this.toolsSum = null;
    this.toolsN = 0;
    this.logEl.empty();
    this.line("sys", "Conversation cleared. Start voice again to talk.");
    void this.session?.stop();
    this.session = null;
    this.phase = "idle";
    this.sid = "";
    this.paintSend();
  }

  private async sendText() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    await this.ask(text, text);
  }

  async ask(display: string, prompt: string) {
    this.showLog();
    this.line("you", display);
    this.botEl = this.line("bot", "…");
    this.toolsEl = null;
    this.toolsList = null;
    this.toolsSum = null;
    this.toolsN = 0;
    try {
      await this.ensure(false);
      await this.session!.sendText(prompt);
    } catch (err) {
      this.line("err", err instanceof Error ? err.message : String(err));
    }
    this.paintSend();
  }

  private safePushContext() {
    const s = this.session as { pushContext?: () => void | Promise<void> } | null;
    void s?.pushContext?.();
  }

  private logDir(): string {
    const dir = this.plugin.manifest.dir || "";
    const ad = this.plugin.app.vault.adapter;
    const base = "getBasePath" in ad && typeof ad.getBasePath === "function" ? ad.getBasePath() : "";
    if (base && dir) return `${base}/${dir}/.voice-logs`;
    return `${dir}/.voice-logs`;
  }

  private handlers(): VoiceHandlers {
    return {
      onPhase: (p) => {
        this.phase = p;
        this.paintSend();
      },
      onSession: (id) => {
        this.sid = id;
        this.paintSend();
      },
      onUser: (id, text) => {
        const key = id || "user";
        let el = this.userRows.get(key);
        if (!el) {
          el = this.line("you", text || "…");
          this.userRows.set(key, el);
          this.botEl = null;
          this.toolsEl = null;
          this.toolsList = null;
          this.toolsSum = null;
          this.toolsN = 0;
        } else if (text) el.setText(text);
      },
      onAssistant: (text, done) => {
        if (!this.botEl) this.botEl = this.line("bot", text || "…");
        else this.botEl.setText(text || (done ? "(no reply)" : "…"));
        this.logEl.scrollTop = this.logEl.scrollHeight;
        if (done) this.botEl = null;
      },
      onTool: (name, detail) => this.addTool(name, detail),
      onError: (msg) => {
        this.line("err", msg);
        new Notice(msg);
      },
    };
  }

  private async ensure(mic: boolean) {
    const tts = this.plugin.settings.ttsProvider || "grok";
    const kind = isDuplexTalk(tts) ? tts : "local";
    if (this.session && this.talkKind !== kind) {
      await this.session.stop();
      this.session = null;
    }
    if (!this.session) {
      this.talkKind = kind;
      const keys = {
        xai: () => this.plugin.xaiKey(),
        openai: () => this.plugin.openaiKey(),
        google: () => this.plugin.googleKey(),
        mistral: () => this.plugin.mistralKey(),
      };
      this.session =
        kind === "local"
          ? new LocalTalkSession(this.agent, () => this.plugin.settings, keys.xai, keys.mistral, keys.openai, keys.google, this.handlers())
          : kind === "openai"
            ? new OpenaiVoiceSession(keys.openai, this.agent, () => this.plugin.settings, this.logDir(), this.handlers())
            : kind === "google"
              ? new GoogleVoiceSession(keys.google, this.agent, () => this.plugin.settings, this.logDir(), this.handlers())
              : new GrokVoiceSession(keys.xai, this.agent, () => this.plugin.settings, this.logDir(), this.handlers());
    }
    await this.session.start(mic);
  }
}

export class JarvisEmbed extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private plugin: LMVoicePlugin
  ) {
    super(containerEl);
  }

  onload() {
    this.plugin.mountEmbed(this.containerEl);
  }

  onunload() {
    this.plugin.releaseEmbed(this.containerEl);
  }
}
