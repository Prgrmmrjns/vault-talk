import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type LMVoicePlugin from "./main";
import { VaultAgent, type ChatMsg } from "./agent";
import { VoiceIO } from "./audio";
import { hotkeyLabel } from "./settings";

export const VIEW_TYPE = "vault-talk-view";

type Phase = "idle" | "listen" | "think" | "speak";

export class VoiceView extends ItemView {
  private rootEl!: HTMLElement;
  private logEl!: HTMLElement;
  private composerEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private modeBtn!: HTMLButtonElement;
  private micBtn!: HTMLButtonElement;
  private inputEl!: HTMLTextAreaElement;
  private running = false;
  private history: ChatMsg[] = [];
  private agent: VaultAgent;
  private voice: VoiceIO;
  private toolsEl: HTMLDetailsElement | null = null;
  private toolsList: HTMLElement | null = null;
  private toolsSum: HTMLElement | null = null;
  private toolsN = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: LMVoicePlugin) {
    super(leaf);
    this.agent = new VaultAgent(this.app, () => this.plugin.settings, this.plugin.agentKeys());
    this.voice = new VoiceIO(
      () => this.plugin.settings,
      () => this.plugin.xaiKey(),
      () => this.plugin.mistralKey(),
      () => this.plugin.openaiKey(),
      () => this.plugin.googleKey()
    );
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Vault Talk";
  }

  getIcon() {
    return "audio-lines";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("lm-voice");
    this.rootEl = root;

    const head = root.createDiv({ cls: "lm-voice-head" });
    const titles = head.createDiv({ cls: "lm-voice-titles" });
    titles.createDiv({ cls: "lm-voice-title", text: "Vault Talk" });
    this.statusEl = titles.createDiv({ cls: "lm-voice-status", text: "Ready" });

    const headBtns = head.createDiv({ cls: "lm-voice-head-btns" });
    this.iconBtn(headBtns, "copy", "Copy chat", () => void this.copyChat());
    this.iconBtn(headBtns, "x", "Clear conversation", () => this.clearChat());
    this.iconBtn(headBtns, "settings", "Open settings", () => this.openSettings());

    this.modeBtn = root.createEl("button", {
      cls: "lm-voice-mode",
      attr: { type: "button", "aria-pressed": "false" },
      text: "Only Dictation",
    });
    this.modeBtn.addEventListener("click", () => void this.toggleDictation());

    const stage = root.createDiv({ cls: "lm-voice-stage" });
    this.micBtn = stage.createEl("button", { cls: "lm-voice-mic", attr: { type: "button", "aria-label": "Talk" } });
    setIcon(this.micBtn, "audio-lines");
    this.micBtn.addEventListener("click", () => void this.toggle());

    this.logEl = root.createDiv({ cls: "lm-voice-log" });
    this.line("sys", "Tap the mic. Pause when you’re done.");

    this.composerEl = root.createDiv({ cls: "lm-voice-row" });
    this.inputEl = this.composerEl.createEl("textarea", {
      cls: "lm-voice-input",
      attr: { rows: "2", placeholder: "Or type a message…" },
    });
    const send = this.composerEl.createEl("button", {
      cls: "lm-voice-send",
      attr: { type: "button", "aria-label": "Send" },
    });
    setIcon(send, "send");
    send.addEventListener("click", () => void this.sendTyped());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.sendTyped();
      }
    });

    this.applyChrome();
  }

  async onClose() {
    this.running = false;
    this.voice.stopListen();
    this.voice.cancelSpeak();
    this.agent.resetCursor();
  }

  private iconBtn(parent: HTMLElement, icon: string, tip: string, onClick: () => void | Promise<void>) {
    const btn = parent.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": tip } });
    btn.setAttr("title", tip);
    setIcon(btn, icon);
    btn.addEventListener("click", () => void onClick());
    return btn;
  }

  private openSettings() {
    const setting = (this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } })
      .setting;
    setting?.open();
    setting?.openTabById(this.plugin.manifest.id);
  }

  private clearChat() {
    this.history = [];
    this.agent.resetCursor();
    this.logEl.empty();
    this.toolsEl = null;
    this.toolsList = null;
    this.toolsSum = null;
    this.toolsN = 0;
    if (!this.plugin.settings.hideChat) this.line("sys", "Conversation cleared.");
  }

  applyChrome() {
    if (!this.rootEl) return;
    const s = this.plugin.settings;
    this.rootEl.setAttr("data-accent", s.accent || "orange");
    this.rootEl.toggleClass("is-quiet", s.hideChat);
    this.rootEl.toggleClass("is-dictate", s.dictation);
    if (this.modeBtn) {
      this.modeBtn.toggleClass("is-on", s.dictation);
      this.modeBtn.setAttr("aria-pressed", s.dictation ? "true" : "false");
    }
    if (s.dictation && !this.running) {
      const keys = hotkeyLabel(s.dictateHotkey);
      this.statusEl.setText(keys ? `${keys} or tap mic → note` : "Tap mic → note");
    } else if (!this.running) {
      const keys = hotkeyLabel(s.dictateHotkey);
      if (keys) this.statusEl.setText(`${keys} to talk`);
    }
  }

  private async toggleDictation() {
    if (this.running) {
      this.running = false;
      this.voice.stopListen();
      this.voice.cancelSpeak();
      this.setPhase("idle");
    }
    this.plugin.dictate.cancel();
    this.plugin.settings.dictation = !this.plugin.settings.dictation;
    await this.plugin.saveSettings();
    this.applyChrome();
  }

  private setPhase(p: Phase) {
    const label = { idle: "Ready", listen: "Listening…", think: "Thinking…", speak: "Speaking…" }[p];
    this.statusEl.setText(label);
    this.micBtn.toggleClass("is-live", p !== "idle");
    this.micBtn.setAttr("aria-label", p === "idle" ? "Talk" : "Stop");
    setIcon(this.micBtn, p === "idle" ? "audio-lines" : "square");
  }

  private async copyText(text: string) {
    const t = text.trim();
    if (!t) return;
    await navigator.clipboard.writeText(t);
    new Notice("Copied");
  }

  private async copyChat() {
    const text = this.history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "You" : "Agent"}: ${m.content}`)
      .join("\n\n");
    await this.copyText(text);
  }

  private addTool(name: string, detail: string) {
    if (this.plugin.settings.hideChat) return;
    if (!this.toolsEl || !this.toolsList || !this.toolsSum) {
      const root = this.logEl.createEl("details", { cls: "lm-voice-tools-drop" });
      const summary = root.createEl("summary", { cls: "lm-voice-tools-sum" });
      const list = root.createDiv({ cls: "lm-voice-tools-list" });
      const bot = this.logEl.querySelector(".lm-voice-msg.is-bot:last-of-type");
      if (bot) this.logEl.insertBefore(root, bot);
      this.toolsEl = root;
      this.toolsList = list;
      this.toolsSum = summary;
      this.toolsN = 0;
    }
    const line = detail ? `${name}: ${detail}` : name;
    const last = this.toolsList.lastElementChild;
    if (last && last.getText().startsWith(`${name}:`) && /running$/i.test(last.getText())) {
      last.setText(line);
    } else {
      this.toolsN++;
      this.toolsList.createDiv({ cls: "lm-voice-tools-item", text: line });
    }
    this.toolsSum.setText(`${this.toolsN} tool${this.toolsN === 1 ? "" : "s"} · ${name}`);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private line(kind: "you" | "bot" | "sys" | "err", text: string) {
    if (this.plugin.settings.hideChat) {
      if (kind === "err") new Notice(text);
      return this.statusEl;
    }
    const el = this.logEl.createDiv({ cls: `lm-voice-msg is-${kind}` });
    const body = el.createDiv({ cls: "lm-voice-msg-text" });
    body.setText(text);
    if (kind === "you" || kind === "bot") {
      const copy = el.createEl("button", {
        cls: "lm-voice-copy clickable-icon",
        attr: { type: "button", "aria-label": "Copy" },
      });
      setIcon(copy, "copy");
      copy.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.copyText(body.getText());
      });
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
    return body;
  }

  async startTalking() {
    if (!this.running) await this.toggle();
  }

  async stopTalking() {
    if (this.running) await this.toggle();
  }

  async toggle() {
    if (this.plugin.settings.dictation) {
      this.plugin.dictate.toggle();
      return;
    }
    if (this.running) {
      this.running = false;
      this.voice.stopListen();
      this.voice.cancelSpeak();
      this.setPhase("idle");
      return;
    }
    this.running = true;
    this.setPhase("listen");
    try {
      do {
        this.setPhase("listen");
        const heard = await this.voice.listenTurn();
        if (!this.running) break;
        await this.turn(heard);
      } while (this.running && this.plugin.settings.keepListening);
    } catch (err) {
      if (this.running) this.line("err", err instanceof Error ? err.message : String(err));
    } finally {
      this.running = false;
      this.setPhase("idle");
    }
  }

  private async sendTyped() {
    const t = this.inputEl.value.trim();
    if (!t || this.running) return;
    this.inputEl.value = "";
    this.running = true;
    try {
      await this.turn(t);
    } catch (err) {
      this.line("err", err instanceof Error ? err.message : String(err));
    } finally {
      this.running = false;
      this.setPhase("idle");
    }
  }

  private async turn(user: string) {
    this.line("you", user);
    this.history.push({ role: "user", content: user });
    this.setPhase("think");
    this.toolsEl = null;
    this.toolsList = null;
    this.toolsSum = null;
    this.toolsN = 0;
    const botEl = this.line("bot", "…");
    const reply = await this.agent.run(this.history, (name, detail) => this.addTool(name, detail));
    botEl.setText(reply || "(no reply)");
    if (this.plugin.settings.hideChat && reply) this.statusEl.setText(reply.slice(0, 80));
    this.history.push({ role: "assistant", content: reply });
    if (this.history.length > 24) this.history = this.history.slice(-24);
    if (reply && this.plugin.settings.speakReplies) {
      this.setPhase("speak");
      await this.voice.speak(reply);
    }
  }
}
