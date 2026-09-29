import { Plugin } from "obsidian";
import { Dictation } from "./dictate";
import { DEFAULT_SETTINGS, LMVoiceSettingTab, ACCENTS, type LMVoiceSettings } from "./settings";
import { CHAT_PROVIDERS, SPEECH_PROVIDERS } from "./providers";
import { VIEW_TYPE, VoiceView } from "./view";

export default class LMVoicePlugin extends Plugin {
  settings: LMVoiceSettings = DEFAULT_SETTINGS;
  dictate!: Dictation;

  async onload() {
    await this.loadSettings();
    this.dictate = new Dictation(this);
    this.dictate.onload();
    this.registerView(VIEW_TYPE, (leaf) => new VoiceView(leaf, this));
    this.addRibbonIcon("mic", "Open Vault Talk", () => void this.activate());
    this.addCommand({ id: "open", name: "Open", callback: () => void this.activate() });
    this.addCommand({
      id: "start-talking",
      name: "Start talking",
      callback: () => void this.withView((v) => v.startTalking()),
    });
    this.addCommand({
      id: "stop-talking",
      name: "Stop talking",
      callback: () => void this.withView((v) => v.stopTalking()),
    });
    this.addSettingTab(new LMVoiceSettingTab(this.app, this));
  }

  private async withView(fn: (view: VoiceView) => void | Promise<void>) {
    await this.activate();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof VoiceView) await fn(leaf.view);
    }
  }

  async activate() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) || workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  async mistralKey(): Promise<string> {
    if (this.settings.apiKey) return this.settings.apiKey;
    try {
      const env = await this.app.vault.adapter.read(".env");
      const m = env.match(/^MISTRAL_API_KEY\s*=\s*["']?([^"'\r\n]+)/m);
      if (m?.[1]) return m[1].trim();
    } catch {
      /* missing */
    }
    throw new Error("Add your Mistral API key in plugin settings.");
  }

  async loadSettings() {
    const raw = (await this.loadData()) as unknown;
    const extra = raw && typeof raw === "object" ? (raw as Partial<LMVoiceSettings>) : {};
    this.settings = { ...DEFAULT_SETTINGS, ...extra };
    if (!ACCENTS.some((a) => a.id === this.settings.accent)) this.settings.accent = "theme";
    if (!CHAT_PROVIDERS.some((p) => p.id === this.settings.chatProvider)) this.settings.chatProvider = "mistral";
    if (!SPEECH_PROVIDERS.some((p) => p.id === this.settings.sttProvider)) this.settings.sttProvider = "mistral";
    if (!SPEECH_PROVIDERS.some((p) => p.id === this.settings.ttsProvider)) this.settings.ttsProvider = "mistral";
  }

  async saveData(data: unknown): Promise<void> {
    await super.saveData(data);
    this.dictate?.sync();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof VoiceView) leaf.view.applyChrome();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
