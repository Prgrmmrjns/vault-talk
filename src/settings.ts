import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type LMVoicePlugin from "./main";
import {
  CHAT_PROVIDERS,
  DEFAULT_CHAT_URL,
  DEFAULT_KOKORO_URL,
  DEFAULT_WHISPER_URL,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  defaultChatModel,
  listChatModels,
  type ChatProvider,
  type SttProvider,
  type TtsProvider,
} from "./providers";
import { CURSOR_MODELS, GROK_VOICES, KOKORO_VOICES, MISTRAL_VOICES } from "./voices";

export const ACCENTS = [
  { id: "theme", label: "Theme" },
  { id: "red", label: "Red" },
  { id: "orange", label: "Orange" },
  { id: "yellow", label: "Yellow" },
  { id: "green", label: "Green" },
  { id: "cyan", label: "Cyan" },
  { id: "blue", label: "Blue" },
  { id: "pink", label: "Pink" },
  { id: "purple", label: "Purple" },
] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];

export type DictateHotkey = { mods: string[]; key: string };

export const DEFAULT_DICTATE_HOTKEY: DictateHotkey = { mods: ["Ctrl"], key: "X" };
export const DEFAULT_NOTE_HOTKEY: DictateHotkey = { mods: ["Ctrl"], key: "D" };

const MODS = new Set(["Mod", "Ctrl", "Meta", "Shift", "Alt"]);

export function hotkeyLabel(hk: DictateHotkey | null | undefined): string {
  if (!hk?.key) return "";
  const mac = Platform.isMacOS;
  const bits: string[] = [];
  for (const m of hk.mods) {
    if (m === "Mod" || m === "Meta") bits.push(mac ? "⌘" : "Ctrl");
    else if (m === "Ctrl") bits.push(mac ? "⌃" : "Ctrl");
    else if (m === "Alt") bits.push(mac ? "⌥" : "Alt");
    else if (m === "Shift") bits.push(mac ? "⇧" : "Shift");
  }
  bits.push(hk.key === " " || hk.key === "Space" ? "Space" : hk.key);
  return mac ? bits.join("") : bits.join("+");
}

export function eventToHotkey(e: KeyboardEvent): DictateHotkey | null {
  if (e.repeat) return null;
  if (e.key === "Escape" || e.key === "Backspace" || e.key === "Delete") return null;
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.metaKey || (e.ctrlKey && !Platform.isMacOS)) mods.push("Mod");
  else if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const fn = /^F\d{1,2}$/.test(e.key);
  if (!mods.length && !fn) return null;
  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  return { mods, key };
}

export function matchesHotkey(e: KeyboardEvent, hk: DictateHotkey | null | undefined): boolean {
  if (!hk?.key || e.repeat) return false;
  const want = new Set(hk.mods);
  const wantMod = want.has("Mod") || want.has("Meta");
  const wantCtrl = want.has("Ctrl");
  const wantAlt = want.has("Alt");
  const wantShift = want.has("Shift");
  if (Platform.isMacOS) {
    if (e.metaKey !== wantMod) return false;
    if (e.ctrlKey !== wantCtrl) return false;
  } else {
    if (e.ctrlKey !== (wantMod || wantCtrl)) return false;
    if (e.metaKey) return false;
  }
  if (e.altKey !== wantAlt) return false;
  if (e.shiftKey !== wantShift) return false;
  if (hk.key === "Space" || hk.key === " ") return e.code === "Space" || e.key === " ";
  if (hk.key.length === 1) {
    return e.key.toLowerCase() === hk.key.toLowerCase() || e.code === `Key${hk.key.toUpperCase()}`;
  }
  return e.key === hk.key || e.code === hk.key;
}

export function cmHotkeySeq(hk: DictateHotkey | null | undefined): string | null {
  if (!hk?.key) return null;
  const parts: string[] = [];
  if (hk.mods.includes("Mod") || hk.mods.includes("Meta")) parts.push("Mod");
  else if (hk.mods.includes("Ctrl")) parts.push("Ctrl");
  if (hk.mods.includes("Alt")) parts.push("Alt");
  if (hk.mods.includes("Shift")) parts.push("Shift");
  const k = hk.key === " " || hk.key === "Space" ? "Space" : hk.key.length === 1 ? hk.key.toLowerCase() : hk.key;
  parts.push(k);
  return parts.join("-");
}

export function scopeMods(hk: DictateHotkey): string[] {
  return hk.mods.filter((m) => MODS.has(m));
}

export interface LMVoiceSettings {
  xaiApiKey: string;
  grokVoice: string;
  cursorApiKey: string;
  chatProvider: ChatProvider;
  sttProvider: SttProvider;
  ttsProvider: TtsProvider;
  whisperUrl: string;
  kokoroUrl: string;
  kokoroVoice: string;
  mistralApiKey: string;
  mistralVoice: string;
  ollamaUrl: string;
  llmModel: string;
  accent: AccentId;
  speakReplies: boolean;
  keepListening: boolean;
  hideChat: boolean;
  dictation: boolean;
  dictateOpen: boolean;
  dictateHotkey: DictateHotkey;
  noteHotkey: DictateHotkey;
  editFiles: boolean;
  allowInternet: boolean;
  openAfterWrite: boolean;
  notesFolder: string;
  personalityFile: string;
}

export const DEFAULT_SETTINGS: LMVoiceSettings = {
  xaiApiKey: "",
  grokVoice: "eve",
  cursorApiKey: "",
  chatProvider: "cursor",
  sttProvider: "grok",
  ttsProvider: "grok",
  whisperUrl: DEFAULT_WHISPER_URL,
  kokoroUrl: DEFAULT_KOKORO_URL,
  kokoroVoice: "af_heart",
  mistralApiKey: "",
  mistralVoice: "gb_jane_neutral",
  ollamaUrl: DEFAULT_CHAT_URL.ollama,
  llmModel: "composer-2.5",
  accent: "orange",
  speakReplies: true,
  keepListening: true,
  hideChat: false,
  dictation: false,
  dictateOpen: true,
  dictateHotkey: DEFAULT_DICTATE_HOTKEY,
  noteHotkey: DEFAULT_NOTE_HOTKEY,
  editFiles: true,
  allowInternet: false,
  openAfterWrite: false,
  notesFolder: "",
  personalityFile: "Jarvis.md",
};

function dropdown(
  setting: Setting,
  options: { id: string; label: string }[],
  value: string,
  onChange: (v: string) => Promise<void>
) {
  setting.addDropdown((d) => {
    for (const o of options) d.addOption(o.id, o.label);
    if (value && !options.some((o) => o.id === value)) d.addOption(value, value);
    d.setValue(value);
    d.onChange((v) => void onChange(v));
  });
}

function choiceMap(options: { id: string; label: string }[]) {
  const out: Record<string, string> = {};
  for (const o of options) out[o.id] = o.label;
  return out;
}

function isHtml(el: ChildNode): el is HTMLElement {
  const node = el as ChildNode & { instanceOf?: (t: typeof HTMLElement) => boolean };
  return typeof node.instanceOf === "function" && node.instanceOf(HTMLElement);
}

export class LMVoiceSettingTab extends PluginSettingTab {
  plugin: LMVoicePlugin;

  constructor(app: App, plugin: LMVoicePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    super.display();
    this.plugin.desk?.renderSettings(this.containerEl);
  }

  private hotkeyItem(
    name: string,
    desc: string,
    key: "dictateHotkey" | "noteHotkey",
    save: (fn: () => void) => Promise<void>
  ) {
    return {
      name,
      desc,
      render: (setting: Setting) => {
        const cur = this.plugin.settings;
        const btn = setting.controlEl.createEl("button", { cls: "vt-hotkey", attr: { type: "button" } });
        const paint = () => btn.setText(hotkeyLabel(cur[key]) || "None");
        paint();
        let rec = false;
        const done = () => {
          rec = false;
          btn.removeClass("is-rec");
          paint();
        };
        btn.addEventListener("click", () => {
          rec = true;
          btn.addClass("is-rec");
          btn.setText("Press keys…");
          btn.focus();
        });
        btn.addEventListener("keydown", (e) => {
          if (!rec) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") {
            done();
            return;
          }
          if (e.key === "Backspace" || e.key === "Delete") {
            void save(() => {
              cur[key] = { mods: [], key: "" };
            });
            done();
            return;
          }
          const hk = eventToHotkey(e);
          if (!hk) return;
          void save(() => {
            cur[key] = hk;
          });
          done();
        });
      },
    };
  }

  getSettingDefinitions(): ReturnType<PluginSettingTab["getSettingDefinitions"]> {
    const s = this.plugin.settings;
    const save = async (fn: () => void) => {
      fn();
      await this.plugin.saveSettings();
    };
    return [
      {
        type: "group" as const,
        heading: "Providers",
        items: [
          {
            name: "xAI API key",
            desc: "From console.x.ai. Leave empty to use XAI_API_KEY in a vault .env file. Used for Grok Voice and Grok STT.",
            render: (setting: Setting) => {
              const cur = this.plugin.settings;
              setting.addText((t) => {
                t.inputEl.type = "password";
                t.setPlaceholder("xai-…");
                t.setValue(cur.xaiApiKey).onChange((v) => save(() => (cur.xaiApiKey = v.trim())));
              });
            },
          },
          {
            name: "Speech to text",
            desc: "Dictation, and Jarvis listen when Talk is not Grok Voice. Whisper needs a local OpenAI-compatible server.",
            render: (setting: Setting) => {
              dropdown(setting, STT_PROVIDERS, s.sttProvider || "grok", async (v) => {
                await save(() => (s.sttProvider = v as SttProvider));
                this.update();
              });
            },
          },
          {
            name: "Whisper URL",
            desc: "OpenAI-compatible /v1 (faster-whisper, Speaches, whisper.cpp proxy). Default http://127.0.0.1:9000/v1",
            visible: () => this.plugin.settings.sttProvider === "whisper",
            control: { type: "text", key: "whisperUrl", placeholder: DEFAULT_WHISPER_URL },
          },
          {
            name: "Talk",
            desc: "Grok Voice is speech-to-speech. Kokoro or Mistral: listen with Speech to text, reply with Chat, then speak.",
            render: (setting: Setting) => {
              dropdown(setting, TTS_PROVIDERS, s.ttsProvider || "grok", async (v) => {
                await save(() => (s.ttsProvider = v as TtsProvider));
                this.update();
              });
            },
          },
          {
            name: "Jarvis voice",
            desc: "Grok speech-to-speech voice.",
            visible: () => this.plugin.settings.ttsProvider === "grok",
            render: (setting: Setting) => {
              dropdown(setting, GROK_VOICES, s.grokVoice || "eve", (v) => save(() => (s.grokVoice = v)));
            },
          },
          {
            name: "Kokoro URL",
            desc: "OpenAI-compatible /v1 (Kokoro-FastAPI). Default http://127.0.0.1:8880/v1",
            visible: () => this.plugin.settings.ttsProvider === "kokoro",
            control: { type: "text", key: "kokoroUrl", placeholder: DEFAULT_KOKORO_URL },
          },
          {
            name: "Kokoro voice",
            visible: () => this.plugin.settings.ttsProvider === "kokoro",
            render: (setting: Setting) => {
              dropdown(setting, KOKORO_VOICES, s.kokoroVoice || "af_heart", (v) => save(() => (s.kokoroVoice = v)));
            },
          },
          {
            name: "Mistral API key",
            desc: "From console.mistral.ai. Leave empty to use MISTRAL_API_KEY in a vault .env file.",
            visible: () => this.plugin.settings.sttProvider === "mistral" || this.plugin.settings.ttsProvider === "mistral",
            render: (setting: Setting) => {
              const cur = this.plugin.settings;
              setting.addText((t) => {
                t.inputEl.type = "password";
                t.setPlaceholder("…");
                t.setValue(cur.mistralApiKey).onChange((v) => save(() => (cur.mistralApiKey = v.trim())));
              });
            },
          },
          {
            name: "Mistral voice",
            visible: () => this.plugin.settings.ttsProvider === "mistral",
            render: (setting: Setting) => {
              dropdown(setting, MISTRAL_VOICES, s.mistralVoice || "gb_jane_neutral", (v) =>
                save(() => (s.mistralVoice = v))
              );
            },
          },
          {
            name: "Chat",
            desc: "Cursor (SDK against this vault) or Ollama. Used for typed turns, and for Jarvis when Talk is Kokoro or Mistral.",
            render: (setting: Setting) => {
              dropdown(setting, CHAT_PROVIDERS, s.chatProvider, async (v) => {
                await save(() => {
                  const next = v as ChatProvider;
                  s.chatProvider = next;
                  if (next === "cursor" && !CURSOR_MODELS.some((m) => m.id === s.llmModel)) {
                    s.llmModel = defaultChatModel("cursor");
                  }
                });
                this.update();
              });
            },
          },
          {
            name: "Ollama URL",
            desc: "OpenAI-compatible base. Default http://127.0.0.1:11434/v1",
            visible: () => this.plugin.settings.chatProvider === "ollama",
            control: { type: "text", key: "ollamaUrl", placeholder: DEFAULT_CHAT_URL.ollama },
          },
          {
            name: "Chat model",
            visible: () => this.plugin.settings.chatProvider === "cursor",
            control: { type: "dropdown", key: "llmModel", options: choiceMap(CURSOR_MODELS) },
          },
          {
            name: "Chat model",
            desc: "Must be loaded. Refresh lists /v1/models.",
            visible: () => {
              const p = this.plugin.settings.chatProvider;
              return p !== "cursor";
            },
            render: (setting: Setting) => {
              const cur = this.plugin.settings;
              setting.addText((t) => {
                t.setPlaceholder(cur.chatProvider === "ollama" ? "llama3.2" : "model id");
                t.setValue(cur.llmModel).onChange((v) => save(() => (cur.llmModel = v.trim())));
              });
              setting.addExtraButton((btn) =>
                btn
                  .setIcon("refresh-cw")
                  .setTooltip("List models")
                  .onClick(async () => {
                    try {
                      const ids = await listChatModels(this.plugin.settings);
                      if (!ids.length) throw new Error("No models. Is the server running?");
                      const first = ids[0] || "";
                      if (!ids.includes(cur.llmModel) && first) {
                        cur.llmModel = first;
                        await this.plugin.saveSettings();
                      }
                      new Notice(ids.slice(0, 12).join("\n"));
                      this.update();
                    } catch (err) {
                      new Notice(err instanceof Error ? err.message : String(err));
                    }
                  })
              );
            },
          },
          {
            name: "Cursor API key",
            desc: "From cursor.com/dashboard/api. Leave empty to use CURSOR_API_KEY in a vault .env file.",
            visible: () => this.plugin.settings.chatProvider === "cursor",
            render: (setting: Setting) => {
              const cur = this.plugin.settings;
              setting.addText((t) => {
                t.inputEl.type = "password";
                t.setPlaceholder("cursor_…");
                t.setValue(cur.cursorApiKey).onChange((v) => save(() => (cur.cursorApiKey = v.trim())));
              });
            },
          },
        ],
      },
      {
        type: "group" as const,
        heading: "Interface",
        items: [
          {
            name: "Accent",
            desc: "Theme follows Appearance. Or pick a color for buttons and chat. Default orange.",
            render: (setting: Setting) => {
              const cur = this.plugin.settings;
              const swatches = setting.controlEl.createDiv({ cls: "lm-voice-swatches" });
              for (const a of ACCENTS) {
                const btn = swatches.createEl("button", {
                  cls: "lm-voice-swatch",
                  attr: { type: "button", "data-accent": a.id, "aria-label": a.label, title: a.label },
                });
                btn.toggleClass("is-on", cur.accent === a.id);
                btn.addEventListener("click", () =>
                  void save(() => {
                    cur.accent = a.id;
                    for (const el of Array.from(swatches.children)) {
                      if (isHtml(el)) el.toggleClass("is-on", el.getAttr("data-accent") === a.id);
                    }
                  })
                );
              }
            },
          },
          { name: "Speak replies", desc: "Play the assistant’s answer out loud.", control: { type: "toggle", key: "speakReplies" } },
          this.hotkeyItem(
            "Chat",
            "Opens Jarvis and shows the conversation. Starts and stops voice. Default Ctrl+X. Escape stops.",
            "dictateHotkey",
            save
          ),
          this.hotkeyItem(
            "Dictate",
            "Types into the open note at the cursor. Default Ctrl+D. Escape stops.",
            "noteHotkey",
            save
          ),
        ],
      },
      {
        type: "group" as const,
        heading: "Files",
        items: [
          {
            name: "Edit files",
            desc: "Yes: list, read, create, and edit markdown. No: talk only. Never deletes.",
            control: { type: "toggle", key: "editFiles" },
          },
          { name: "Use internet", desc: "Allow fetching a public http(s) page as text.", control: { type: "toggle", key: "allowInternet" } },
          { name: "Open after write", desc: "Open a note after the agent creates or edits it. They can also open a note when you ask.", control: { type: "toggle", key: "openAfterWrite" } },
          { name: "Notes folder", desc: "Limit file tools to this folder. Empty = whole vault. Cursor uses it as the working directory.", control: { type: "text", key: "notesFolder", placeholder: "e.g. Notes" } },
        ],
      },
      {
        type: "group" as const,
        heading: "Agent",
        items: [
          {
            name: "Jarvis note",
            desc: "Prompt and behavior memory. Jarvis may add bullets under # Memory. Live open files, PDFs, and cursor are appended automatically. Default Jarvis.md.",
            control: { type: "text", key: "personalityFile", placeholder: "Jarvis.md" },
          },
        ],
      },
    ] as ReturnType<PluginSettingTab["getSettingDefinitions"]>;
  }
}
