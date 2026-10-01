import { App, FuzzySuggestModal, MarkdownRenderChild, Notice, setIcon, TFile, type EventRef } from "obsidian";
import { VaultAgent } from "./agent";
import { GrokVoiceSession, type VoiceHandlers, type VoicePhase } from "./grok-voice";
import { GoogleVoiceSession } from "./google-voice";
import { LocalTalkSession } from "./local-talk";
import { OpenaiVoiceSession } from "./openai-voice";
import { isDuplexTalk } from "./providers";
import { cursorCatalog } from "./cursor-chat";
import {
  clampParams,
  cleanLabel,
  contextParam,
  fastParam,
  findModel,
  thinkSwitch,
  thinkingParam,
  type CursorModel,
  type ModelParam,
} from "./cursor-models";
import type { LogSink } from "./voice-log";
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
  private column: boolean;
  private modelBtn!: HTMLButtonElement;
  private modeEl!: HTMLElement;
  private micBtn!: HTMLButtonElement;
  private filesEl!: HTMLElement;
  private files: TFile[] = [];
  private popEl: HTMLElement | null = null;
  private popOff: (() => void) | null = null;
  private catalog: CursorModel[] = [];

  constructor(
    private plugin: LMVoicePlugin,
    private host: HTMLElement,
    opts?: { compact?: boolean; column?: boolean }
  ) {
    this.column = !!opts?.column;
    this.compact = !!opts?.compact && !this.column;
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
    this.closeModels();
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
    if (this.column) root.addClass("is-column");
    else if (this.compact) root.addClass("is-embed");
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
    this.line(
      "sys",
      this.column
        ? "Tell me what this page is for, and what the next step is."
        : this.compact
          ? "Talk or type — on today’s desk."
          : "Talk or type. Headphones recommended."
    );

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
    const compose = row.createDiv({ cls: "vt-j-compose" });
    this.filesEl = compose.createDiv({ cls: "vt-j-files" });
    const bar = compose.createDiv({ cls: "vt-j-barline" });
    const plus = bar.createEl("button", {
      cls: "vt-j-plus",
      attr: { type: "button", "aria-label": "Add a file" },
    });
    setIcon(plus, "plus");
    plus.addEventListener("click", () => this.pickFile());
    this.inputEl = bar.createEl("textarea", {
      cls: "vt-j-input",
      attr: { rows: "1", placeholder: this.column ? "What’s the next step?" : PLACE.idle },
    });
    this.modelBtn = bar.createEl("button", {
      cls: "vt-j-model",
      attr: { type: "button", "aria-haspopup": "listbox", "aria-label": "Model" },
    });
    this.modelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.popEl) this.closeModels();
      else void this.openModels();
    });
    this.modeEl = bar.createDiv({ cls: "vt-j-modechips" });
    this.micBtn = bar.createEl("button", {
      cls: "vt-j-mic",
      attr: { type: "button", "aria-label": "Voice" },
    });
    setIcon(this.micBtn, "mic");
    this.micBtn.addEventListener("click", () => void this.toggleVoice());
    this.sendBtn = bar.createEl("button", {
      cls: "vt-j-send",
      attr: { type: "button", "aria-label": "Send" },
    });
    setIcon(this.sendBtn, "arrow-up");
    this.sendBtn.addEventListener("click", () => void this.sendText());
    this.inputEl.addEventListener("input", () => this.paintSend());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.sendText();
      }
    });
    this.srEl = row.createSpan({ cls: "sr-only", attr: { role: "status" } });
    this.paintSend();
    this.paintModel();
    void this.loadModels();
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
    const voiceLabel = live ? (this.session?.micOn ? "End voice" : "Start microphone") : "Voice";
    if (this.orbBtn) {
      this.orbBtn.className = "vt-j-orb" + (live ? " is-live is-" + this.phase : " is-idle");
      this.orbBtn.setAttribute("aria-label", voiceLabel);
    }
    if (this.micBtn) {
      this.micBtn.className = "vt-j-mic" + (live ? " is-on is-" + this.phase : "");
      this.micBtn.setAttribute("aria-label", voiceLabel);
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

  private async loadModels() {
    if (this.plugin.settings.chatProvider !== "cursor") {
      this.paintModel();
      return;
    }
    try {
      this.catalog = await cursorCatalog(await this.plugin.cursorKey());
    } catch {
      this.catalog = [];
    }
    const model = findModel(this.catalog, this.plugin.settings.llmModel);
    if (model && !Object.keys(this.plugin.settings.cursorParams || {}).length) {
      this.plugin.settings.cursorParams = clampParams(model, this.plugin.settings.cursorChoices?.[model.id]);
    }
    this.paintModel();
  }

  private currentModel(): CursorModel | undefined {
    return findModel(this.catalog, this.plugin.settings.llmModel);
  }

  private paintModel() {
    const cursor = this.plugin.settings.chatProvider === "cursor";
    this.modelBtn?.toggle(cursor);
    this.modeEl?.hide();
    if (!this.modelBtn) return;
    const model = this.currentModel();
    const params = model ? clampParams(model, this.plugin.settings.cursorParams) : {};
    const name = model?.displayName || (this.plugin.settings.llmModel === "default" ? "Auto" : this.plugin.settings.llmModel || "Auto");
    const think = thinkingParam(model);
    const thinkVal = think ? params[think.id] : "";
    const thinkLabel = think?.values.find((v) => v.value === thinkVal);
    const thinkOn = !(thinkSwitch(model) && params.thinking === "false");
    const bits = [name];
    if (thinkOn && (thinkLabel || thinkVal)) bits.push(cleanLabel(thinkLabel?.displayName, thinkVal || ""));
    if (fastParam(model) && params.fast === "true") bits.push("Fast");
    const label = bits.filter(Boolean).join(" ");
    this.modelBtn.empty();
    this.modelBtn.createSpan({ text: label });
    setIcon(this.modelBtn.createSpan({ cls: "vt-j-chev" }), "chevron-down");
    this.modelBtn.setAttribute("aria-label", label);
  }

  private async openModels() {
    if (!this.catalog.length) await this.loadModels();
    this.closeModels();
    const pop = document.body.createDiv({ cls: "vt-model-pop" });
    this.popEl = pop;
    const search = pop.createEl("input", {
      cls: "vt-model-search",
      attr: { type: "search", placeholder: "Search models", spellcheck: "false" },
    });
    const list = pop.createDiv({ cls: "vt-model-list", attr: { role: "listbox" } });
    const opts = pop.createDiv({ cls: "vt-model-opts" });
    const draw = () => {
      this.fillModelList(list, search.value);
      this.fillModelOpts(opts);
    };
    search.addEventListener("input", () => this.fillModelList(list, search.value));
    draw();
    this.placePop();
    const onDoc = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (pop.contains(t) || this.modelBtn.contains(t)) return;
      this.closeModels();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeModels();
    };
    window.setTimeout(() => {
      document.addEventListener("pointerdown", onDoc, true);
      document.addEventListener("keydown", onKey);
      search.focus();
    }, 0);
    this.popOff = () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    };
  }

  private placePop() {
    const pop = this.popEl;
    const host = this.modelBtn?.closest(".vt-j-compose") || this.modelBtn;
    if (!pop || !host) return;
    const box = host.getBoundingClientRect();
    const space = box.top - 12;
    pop.style.left = `${box.left}px`;
    pop.style.width = `${Math.max(240, box.width)}px`;
    pop.style.bottom = `${window.innerHeight - box.top + 8}px`;
    pop.style.maxHeight = `${Math.max(200, Math.min(440, space))}px`;
  }

  private closeModels() {
    this.popOff?.();
    this.popOff = null;
    this.popEl?.remove();
    this.popEl = null;
  }

  private fillModelList(list: HTMLElement, query: string) {
    list.empty();
    const q = query.trim().toLowerCase();
    const current = this.currentModel()?.id || this.plugin.settings.llmModel;
    const rows = this.catalog.filter((m) => !q || m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    if (!rows.length) {
      list.createDiv({ cls: "vt-model-empty", text: "No models" });
      return;
    }
    for (const m of rows) {
      const row = list.createEl("button", {
        cls: "vt-model-row" + (m.id === current ? " is-on" : ""),
        attr: { type: "button", role: "option" },
      });
      row.createSpan({ text: m.displayName });
      if (m.id === current) setIcon(row.createSpan({ cls: "vt-model-check" }), "check");
      row.addEventListener("click", () => void this.pickModel(m.id));
    }
  }

  private fillModelOpts(host: HTMLElement) {
    host.empty();
    const model = this.currentModel();
    if (!model?.parameters?.length) return;
    const params = clampParams(model, this.plugin.settings.cursorParams);
    const gate = thinkSwitch(model);
    const effort = thinkingParam(model);
    if (gate) this.optRow(host, effort ? "Think" : "Thinking", gate, params);
    if (effort && params.thinking !== "false") this.optRow(host, "Thinking", effort, params);
    const fast = fastParam(model);
    if (fast) this.optRow(host, "Fast", fast, params);
    const ctx = contextParam(model);
    if (ctx) this.optRow(host, "Context", ctx, params);
  }

  private optRow(host: HTMLElement, title: string, param: ModelParam, params: Record<string, string>) {
    const row = host.createDiv({ cls: "vt-model-opt" });
    row.createDiv({ cls: "vt-model-opt-k", text: title });
    const pills = row.createDiv({ cls: "vt-model-pills" });
    const current = params[param.id];
    if (param.id === "fast") {
      const on = current === "true";
      const btn = pills.createEl("button", {
        cls: "vt-model-pill" + (on ? " is-on" : ""),
        attr: { type: "button" },
        text: on ? "Fast" : "Standard",
      });
      btn.addEventListener("click", () => void this.setParam("fast", on ? "false" : "true"));
      return;
    }
    for (const v of param.values) {
      const btn = pills.createEl("button", {
        cls: "vt-model-pill" + (v.value === current ? " is-on" : ""),
        attr: { type: "button" },
        text: cleanLabel(v.displayName, v.value === "true" ? "On" : v.value === "false" ? "Off" : v.value),
      });
      btn.addEventListener("click", () => void this.setParam(param.id, v.value));
    }
  }

  private async pickModel(id: string) {
    const model = findModel(this.catalog, id);
    if (!model) return;
    const saved = this.plugin.settings.cursorChoices?.[model.id];
    this.plugin.settings.llmModel = model.id;
    this.plugin.settings.cursorParams = clampParams(model, saved);
    this.plugin.settings.cursorChoices[model.id] = { ...this.plugin.settings.cursorParams };
    await this.plugin.saveSettings();
    this.paintModel();
    const pop = this.popEl;
    if (!pop) return;
    const list = pop.querySelector(".vt-model-list");
    const opts = pop.querySelector(".vt-model-opts");
    const search = pop.querySelector("input");
    if (list instanceof HTMLElement) this.fillModelList(list, search instanceof HTMLInputElement ? search.value : "");
    if (opts instanceof HTMLElement) this.fillModelOpts(opts);
  }

  private async setParam(id: string, value: string) {
    const model = this.currentModel();
    if (!model) return;
    const next = clampParams(model, { ...this.plugin.settings.cursorParams, [id]: value });
    next[id] = value;
    this.plugin.settings.cursorParams = next;
    this.plugin.settings.cursorChoices[model.id] = { ...next };
    await this.plugin.saveSettings();
    this.paintModel();
    const opts = this.popEl?.querySelector(".vt-model-opts");
    if (opts instanceof HTMLElement) this.fillModelOpts(opts);
  }

  private line(kind: "you" | "bot" | "sys" | "err", text: string): HTMLElement {
    if (kind !== "sys") this.rootEl?.addClass("has-talk");
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
    this.rootEl?.removeClass("has-talk");
    this.logEl.empty();
    this.line("sys", "Conversation cleared. Start voice again to talk.");
    void this.session?.stop();
    this.session = null;
    this.phase = "idle";
    this.sid = "";
    this.files = [];
    this.paintFiles();
    this.paintSend();
  }

  private pickFile() {
    const modal = new FileContextModal(this.plugin.app, (file) => {
      if (this.files.some((f) => f.path === file.path)) return;
      this.files.push(file);
      this.paintFiles();
    });
    modal.open();
  }

  private paintFiles() {
    this.filesEl.empty();
    this.filesEl.toggle(this.files.length > 0);
    this.filesEl.parentElement?.toggleClass("has-file", this.files.length > 0);
    for (const file of this.files) {
      const chip = this.filesEl.createSpan({ cls: "vt-j-file" });
      chip.createSpan({ text: file.basename });
      const x = chip.createEl("button", { cls: "vt-j-file-x", attr: { type: "button", "aria-label": `Remove ${file.basename}` } });
      setIcon(x, "x");
      x.addEventListener("click", () => {
        this.files = this.files.filter((f) => f.path !== file.path);
        this.paintFiles();
      });
    }
  }

  private async fileBlock(): Promise<string> {
    if (!this.files.length) return "";
    const parts = ["[Attached files]"];
    for (const file of this.files) {
      let body = "";
      try {
        if (file.extension === "md" || file.extension === "txt") body = await this.plugin.app.vault.cachedRead(file);
        else body = "(attached by path)";
      } catch {
        body = "(unreadable)";
      }
      if (body.length > 12000) body = `${body.slice(0, 12000)}\n…`;
      parts.push(`${file.path}\n${body}`);
    }
    return parts.join("\n\n");
  }

  private async sendText() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    const files = await this.fileBlock();
    const prompt = await this.withDesk(files ? `${files}\n\n${text}` : text);
    const names = this.files.map((f) => f.basename).join(", ");
    await this.ask(names ? `${text}\n${names}` : text, prompt);
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
      await this.primeDesk();
      if (this.session?.live) await this.session.sendText(prompt);
      else await this.cursorTurn(prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.botEl) this.botEl.setText(msg);
      else this.line("err", msg);
      this.botEl = null;
    }
    this.paintSend();
  }

  private async cursorTurn(prompt: string) {
    this.rootEl.setAttr("data-phase", "thinking");
    const steered = `Reply in a few short sentences. Write the note only after they agree.\n\n${prompt}`;
    const reply = await this.agent.run([{ role: "user", content: steered }], (name, detail) => this.addTool(name, detail));
    if (this.botEl) this.botEl.setText(reply || "(no reply)");
    else this.line("bot", reply || "(no reply)");
    this.botEl = null;
    this.rootEl.setAttr("data-phase", "idle");
  }

  private async withDesk(prompt: string) {
    if (prompt.includes("[Desk context")) return prompt;
    await this.primeDesk();
    return this.agent.deskContext ? `${this.agent.deskContext}\n\n${prompt}` : prompt;
  }

  private async primeDesk() {
    try {
      const desk = this.plugin.desk as { context?: () => Promise<string> } | undefined;
      this.agent.deskContext = (await desk?.context?.()) || "";
    } catch {
      this.agent.deskContext = "";
    }
  }

  private safePushContext() {
    const s = this.session as { pushContext?: () => void | Promise<void> } | null;
    void s?.pushContext?.();
  }

  private logSink(): LogSink {
    const root = this.plugin.manifest.dir;
    if (!root) return () => undefined;
    const dir = `${root}/.voice-logs`;
    const ad = this.plugin.app.vault.adapter;
    return (name, text) => {
      void ad.mkdir(dir).then(() => ad.append(`${dir}/${name}`, text)).catch(() => undefined);
    };
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
    await this.primeDesk();
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
            ? new OpenaiVoiceSession(keys.openai, this.agent, () => this.plugin.settings, this.logSink(), this.handlers())
            : kind === "google"
              ? new GoogleVoiceSession(keys.google, this.agent, () => this.plugin.settings, this.logSink(), this.handlers())
              : new GrokVoiceSession(keys.xai, this.agent, () => this.plugin.settings, this.logSink(), this.handlers());
    }
    await this.session.start(mic);
  }
}

class FileContextModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private onPick: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("Add a file");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension === "md" || f.extension === "pdf" || f.extension === "txt");
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
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
