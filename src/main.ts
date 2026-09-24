import { MarkdownView, Plugin, type WorkspaceLeaf } from "obsidian";
import { Desk } from "./desk";
import { EditorDictate } from "./dictate";
import { DictateView, DICTATE_VIEW } from "./dictate-view";
import { JarvisEmbed, JarvisPanel } from "./jarvis-panel";
import { DEFAULT_SETTINGS, LMVoiceSettingTab, ACCENTS, accentColor, DEFAULT_DICTATE_HOTKEY, DEFAULT_NOTE_HOTKEY, hotkeyLabel, matchesHotkey, type LMVoiceSettings } from "./settings";
import { CHAT_PROVIDERS, STT_PROVIDERS, TTS_PROVIDERS, chatModels, defaultChatModel } from "./providers";

export default class LMVoicePlugin extends Plugin {
  settings: LMVoiceSettings = DEFAULT_SETTINGS;
  deskData: Record<string, unknown> | null = null;
  desk!: Desk;
  dictate!: EditorDictate;
  unloading = false;
  embedPanel: JarvisPanel | null = null;
  sidePanel: JarvisPanel | null = null;
  private embedHost: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    this.dictate = new EditorDictate(this);
    this.registerView(DICTATE_VIEW, (leaf) => new DictateView(leaf, this));
    this.addRibbonIcon("audio-lines", "Jarvis", () => void this.activateDictate());
    this.addCommand({ id: "open-dictate", name: "Open Jarvis", callback: () => void this.activateDictate() });
    this.addCommand({
      id: "toggle-dictate",
      name: "Chat with Jarvis",
      callback: () => void this.openChat(),
    });
    this.addCommand({
      id: "toggle-note-dictate",
      name: "Dictate into note",
      callback: () => this.toggleDictate(),
    });
    this.addSettingTab(new LMVoiceSettingTab(this.app, this));
    this.registerMarkdownCodeBlockProcessor("jarvis", (_source, el, ctx) => {
      el.empty();
      el.addClass("vt-embed-host");
      ctx.addChild(new JarvisEmbed(el, this));
    });
    this.registerDomEvent(
      window,
      "keydown",
      (e: KeyboardEvent) => {
        if ((e.target as HTMLElement | null)?.closest?.(".vt-hotkey")) return;
        if (e.key === "Escape") {
          if (this.dictate.listening) {
            e.preventDefault();
            this.dictate.cancel();
          }
          void this.embedPanel?.haltVoice();
          for (const leaf of this.app.workspace.getLeavesOfType(DICTATE_VIEW)) {
            const v = leaf.view;
            if (v instanceof DictateView) void v.haltVoice();
          }
          return;
        }
        if (matchesHotkey(e, this.settings.dictateHotkey)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          void this.openChat();
          return;
        }
        if (matchesHotkey(e, this.settings.noteHotkey)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          this.toggleDictate();
        }
      },
      { capture: true }
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const v = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (v) this.dictate.remember(v);
      })
    );
    // Desk embeds Jarvis; do not auto-open the right sidebar.
    this.settings.dictateOpen = false;
    this.mountStatus();
    this.dictate.onChange(() => this.refreshChrome());
    this.desk = new Desk(this);
    await this.desk.onload();
  }

  onunload() {
    this.unloading = true;
    this.dictate.cancel();
    void this.embedPanel?.destroy(true);
    this.embedPanel = null;
    this.embedHost = null;
  }

  mountEmbed(host: HTMLElement) {
    host.addClass("vt-embed-host");
    if (this.embedPanel && this.embedHost && this.embedPanel.rootEl) {
      this.embedHost = host;
      this.embedPanel.reattach(host);
      return;
    }
    this.embedHost = host;
    this.embedPanel = new JarvisPanel(this, host, { compact: true });
    this.embedPanel.mount();
  }

  releaseEmbed(host: HTMLElement) {
    if (this.embedHost !== host) return;
    // Keep panel alive briefly — another processor may remount. Detach only.
    if (this.embedPanel?.rootEl && this.embedPanel.rootEl.parentElement === host) {
      this.embedPanel.rootEl.remove();
    }
    this.embedHost = null;
  }

  /** Public: send a prompt to Jarvis; `display` is what the chat log shows. */
  async askJarvis(display: string, prompt = display) {
    if (!this.sidePanel) await this.openSide(false);
    await this.sidePanel?.ask(display, prompt);
  }

  toggleDictate() {
    this.dictate.toggle();
  }

  /** Show the conversation, then start or stop voice. */
  async openChat() {
    if (this.dictate.listening) this.dictate.cancel();
    await this.openSide(true);
    const view = this.sideView();
    view?.showLog();
    await view?.toggleVoice();
  }

  private inRight(leaf: WorkspaceLeaf) {
    return leaf.getRoot() === this.app.workspace.rightSplit;
  }

  /** Prefer the on-screen desk embed; otherwise the sidebar chat. */
  async activateDictate(focus = true) {
    await this.openSide(focus);
    this.sideView()?.showLog();
  }

  private async openSide(focus = true) {
    const { workspace } = this.app;
    for (const leftover of workspace.getLeavesOfType("vault-talk-view")) leftover.detach();
    let leaf = workspace.getLeavesOfType(DICTATE_VIEW)[0];
    if (leaf && !this.inRight(leaf)) {
      leaf.detach();
      leaf = undefined;
    }
    if (!leaf) {
      this.settings.dictateOpen = true;
      await this.saveSettings();
      const ensure = (
        workspace as typeof workspace & {
          ensureSideLeaf?: (
            type: string,
            side: "left" | "right",
            opts?: { active?: boolean; split?: boolean; reveal?: boolean }
          ) => Promise<WorkspaceLeaf>;
        }
      ).ensureSideLeaf;
      if (ensure) {
        leaf = await ensure.call(workspace, DICTATE_VIEW, "right", { active: false, split: false, reveal: focus });
      } else {
        const right = workspace.getRightLeaf(false) || workspace.getLeaf("tab");
        leaf = right;
        await leaf.setViewState({ type: DICTATE_VIEW, active: focus });
      }
      try {
        leaf.setPinned(true);
      } catch {
        /* older Obsidian */
      }
    }
    if (focus) await workspace.revealLeaf(leaf);
  }

  private sideView(): DictateView | null {
    const view = this.app.workspace.getLeavesOfType(DICTATE_VIEW)[0]?.view;
    return view instanceof DictateView ? view : null;
  }

  private statusChat!: HTMLButtonElement;
  private statusDict!: HTMLButtonElement;

  private mountStatus() {
    const bar = this.addStatusBarItem();
    bar.addClass("vt-status");
    this.statusChat = bar.createEl("button", { attr: { type: "button" } });
    this.statusDict = bar.createEl("button", { attr: { type: "button" } });
    this.statusChat.addEventListener("click", () => void this.openChat());
    this.statusDict.addEventListener("click", () => this.toggleDictate());
    this.refreshChrome();
  }

  refreshChrome() {
    const chat = hotkeyLabel(this.settings.dictateHotkey);
    const note = hotkeyLabel(this.settings.noteHotkey);
    const color = accentColor(this.settings.accent);
    this.statusChat?.style.setProperty("--vt-accent", color);
    this.statusDict?.style.setProperty("--vt-accent", color);
    this.statusChat?.setText(chat ? `Chat  ${chat}` : "Chat");
    this.statusChat?.setAttribute("aria-label", chat ? `Chat ${chat}` : "Chat");
    this.statusDict?.setText(note ? `Dictation  ${note}` : "Dictation");
    this.statusDict?.setAttribute("aria-label", note ? `Dictation ${note}` : "Dictation");
    this.statusDict?.toggleClass("is-on", this.dictate?.listening ?? false);
    this.statusChat?.toggleClass("is-on", false);
    this.embedPanel?.paintKeys();
    this.sidePanel?.paintKeys();
  }

  async xaiKey(): Promise<string> {
    if (this.settings.xaiApiKey) return this.settings.xaiApiKey;
    try {
      const env = await this.app.vault.adapter.read(".env");
      const m = env.match(/^XAI_API_KEY\s*=\s*["']?([^"'\r\n]+)/m);
      if (m?.[1]) return m[1].trim();
    } catch {
      /* missing */
    }
    throw new Error("Add your xAI API key in plugin settings.");
  }

  async cursorKey(): Promise<string> {
    if (this.settings.cursorApiKey) return this.settings.cursorApiKey;
    try {
      const env = await this.app.vault.adapter.read(".env");
      const m = env.match(/^CURSOR_API_KEY\s*=\s*["']?([^"'\r\n]+)/m);
      if (m?.[1]) return m[1].trim();
    } catch {
      /* missing */
    }
    throw new Error("Add your Cursor API key in plugin settings.");
  }

  agentKeys() {
    return {
      cursor: () => this.cursorKey(),
      openai: () => this.openaiKey(),
      google: () => this.googleKey(),
      mistral: () => this.mistralKey(),
      anthropic: () => this.anthropicKey(),
    };
  }

  async openaiKey(): Promise<string> {
    if (this.settings.openaiApiKey) return this.settings.openaiApiKey;
    const v = await this.envValue("OPENAI_API_KEY");
    if (v) return v;
    throw new Error("Add your OpenAI API key in plugin settings.");
  }

  async googleKey(): Promise<string> {
    if (this.settings.googleApiKey) return this.settings.googleApiKey;
    const v = (await this.envValue("GOOGLE_API_KEY")) || (await this.envValue("GEMINI_API_KEY"));
    if (v) return v;
    throw new Error("Add your Google API key in plugin settings.");
  }

  async anthropicKey(): Promise<string> {
    if (this.settings.anthropicApiKey) return this.settings.anthropicApiKey;
    const v = await this.envValue("ANTHROPIC_API_KEY");
    if (v) return v;
    throw new Error("Add your Anthropic API key in plugin settings.");
  }

  private async envValue(name: string): Promise<string> {
    try {
      const env = await this.app.vault.adapter.read(".env");
      const m = env.match(new RegExp(`^${name}\\s*=\\s*["']?([^"'\\r\\n]+)`, "m"));
      if (m?.[1]) return m[1].trim();
    } catch {
      /* missing */
    }
    return "";
  }

  async mistralKey(): Promise<string> {
    if (this.settings.mistralApiKey) return this.settings.mistralApiKey;
    const v = await this.envValue("MISTRAL_API_KEY");
    if (v) return v;
    throw new Error("Add your Mistral API key in plugin settings.");
  }

  async loadSettings() {
    const raw = (await this.loadData()) as (Partial<LMVoiceSettings> & { desk?: Record<string, unknown> }) | null;
    this.deskData = raw?.desk ?? null;
    const extra = raw && typeof raw === "object" ? { ...raw } : {};
    delete extra.desk;
    this.settings = { ...DEFAULT_SETTINGS, ...extra };
    const rawEdit = extra as Partial<LMVoiceSettings> & {
      allowTools?: boolean;
      readOnly?: boolean;
      allowEdit?: boolean;
    };
    if (typeof rawEdit.editFiles !== "boolean") {
      this.settings.editFiles = rawEdit.allowTools !== false && rawEdit.readOnly !== true && rawEdit.allowEdit !== false;
    }
    if (!this.settings.noteHotkey || typeof this.settings.noteHotkey.key !== "string") {
      this.settings.noteHotkey = { ...DEFAULT_NOTE_HOTKEY };
    }
    if (!this.settings.dictateHotkey || typeof this.settings.dictateHotkey.key !== "string") {
      this.settings.dictateHotkey = { ...DEFAULT_DICTATE_HOTKEY };
    } else {
      const mods = (this.settings.dictateHotkey.mods || []).join(",");
      const k = this.settings.dictateHotkey.key;
      if ((k === "D" && (mods === "Mod,Shift" || mods === "Mod")) || (k === "d" && mods === "Mod")) {
        this.settings.dictateHotkey = { ...DEFAULT_DICTATE_HOTKEY };
      }
    }
    if (this.settings.personalityFile === "Personality.md" || !this.settings.personalityFile) {
      this.settings.personalityFile = "Jarvis.md";
    }
    if (!ACCENTS.some((a) => a.id === this.settings.accent)) this.settings.accent = "orange";
    if (!CHAT_PROVIDERS.some((p) => p.id === this.settings.chatProvider)) this.settings.chatProvider = "cursor";
    if (!STT_PROVIDERS.some((p) => p.id === this.settings.sttProvider) || this.settings.sttProvider === ("browser" as string)) {
      this.settings.sttProvider = "grok";
    }
    if (!TTS_PROVIDERS.some((p) => p.id === this.settings.ttsProvider) || this.settings.ttsProvider === ("browser" as string)) {
      this.settings.ttsProvider = "grok";
    }
    const models = chatModels(this.settings.chatProvider);
    if (models.length && !models.some((m) => m.id === this.settings.llmModel)) {
      this.settings.llmModel = defaultChatModel(this.settings.chatProvider);
    }
    const stale = [
      "allowTools",
      "readOnly",
      "allowList",
      "allowRead",
      "allowCreate",
      "allowEdit",
      "allowDelete",
      "activeFileOnly",
      "contextNotes",
      "systemPrompt",
      "apiKey",
      "sttModel",
      "ttsModel",
      "ttsVoice",
      "talkEngine",
      "appleVoice",
      "lmStudioUrl",
    ];
    for (const k of stale) delete (this.settings as unknown as Record<string, unknown>)[k];
  }

  async saveSettings() {
    const data: Record<string, unknown> = { ...this.settings };
    delete data.desk;
    if (this.deskData) data.desk = this.deskData;
    await this.saveData(data);
    this.refreshChrome();
  }
}
