import { ItemView, type WorkspaceLeaf } from "obsidian";
import type LMVoicePlugin from "./main";
import { JarvisPanel } from "./jarvis-panel";

export const DICTATE_VIEW = "vault-talk-dictate";

export class DictateView extends ItemView {
  private panel: JarvisPanel | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: LMVoicePlugin
  ) {
    super(leaf);
  }

  getViewType() {
    return DICTATE_VIEW;
  }

  getDisplayText() {
    return "Jarvis";
  }

  getIcon() {
    return "audio-lines";
  }

  async onOpen() {
    this.panel = new JarvisPanel(this.plugin, this.contentEl, { compact: false });
    this.panel.mount();
    this.plugin.sidePanel = this.panel;
  }

  async haltVoice() {
    await this.panel?.haltVoice();
  }

  async toggleVoice() {
    await this.panel?.toggleVoice();
  }

  showLog() {
    this.panel?.showLog();
  }

  async onClose() {
    if (this.plugin.sidePanel === this.panel) this.plugin.sidePanel = null;
    await this.panel?.destroy(true);
    this.panel = null;
    if (!this.plugin.unloading) {
      this.plugin.settings.dictateOpen = false;
      void this.plugin.saveSettings();
    }
  }
}
