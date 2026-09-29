import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LMVoicePlugin from "./main";
import { VoiceIO } from "./audio";
import {
  CHAT_PROVIDERS,
  DEFAULT_CHAT_URL,
  SPEECH_PROVIDERS,
  defaultChatModel,
  listChatModels,
  usesMistral,
  type ChatProvider,
  type SpeechProvider,
} from "./providers";
import { LLM_MODELS, STT_MODELS, TTS_MODELS, TTS_VOICES } from "./voices";

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

export interface LMVoiceSettings {
  apiKey: string;
  chatProvider: ChatProvider;
  sttProvider: SpeechProvider;
  ttsProvider: SpeechProvider;
  ollamaUrl: string;
  lmStudioUrl: string;
  llmModel: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  accent: AccentId;
  speakReplies: boolean;
  keepListening: boolean;
  hideChat: boolean;
  dictation: boolean;
  allowTools: boolean;
  readOnly: boolean;
  allowList: boolean;
  allowRead: boolean;
  allowCreate: boolean;
  allowEdit: boolean;
  allowDelete: boolean;
  allowInternet: boolean;
  openAfterWrite: boolean;
  activeFileOnly: boolean;
  notesFolder: string;
  personalityFile: string;
  contextNotes: string;
  systemPrompt: string;
}

export const DEFAULT_SETTINGS: LMVoiceSettings = {
  apiKey: "",
  chatProvider: "mistral",
  sttProvider: "mistral",
  ttsProvider: "mistral",
  ollamaUrl: DEFAULT_CHAT_URL.ollama,
  lmStudioUrl: DEFAULT_CHAT_URL.lmstudio,
  llmModel: "mistral-small-latest",
  sttModel: "voxtral-mini-latest",
  ttsModel: "voxtral-mini-tts-2603",
  ttsVoice: "en_paul_confident",
  accent: "theme",
  speakReplies: true,
  keepListening: true,
  hideChat: false,
  dictation: false,
  allowTools: true,
  readOnly: false,
  allowList: true,
  allowRead: true,
  allowCreate: true,
  allowEdit: true,
  allowDelete: false,
  allowInternet: false,
  openAfterWrite: false,
  activeFileOnly: false,
  notesFolder: "",
  personalityFile: "Personality.md",
  contextNotes: "",
  systemPrompt: `You are a fast English voice agent inside Obsidian.
Speak short. One or two sentences, then act. No markdown in spoken replies.
After a file change, confirm the path in one short sentence.
Never touch PDFs or binary files. Markdown only.
Today: {{date}}. Active file: {{file}}.`,
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
            name: "Chat",
            desc: "Mistral cloud, or a local OpenAI-compatible server (Ollama / LM Studio).",
            render: (setting: Setting) => {
              dropdown(setting, CHAT_PROVIDERS, s.chatProvider, async (v) => {
                await save(() => {
                  const next = v as ChatProvider;
                  s.chatProvider = next;
                  if (next !== "mistral" && /^mistral-/i.test(s.llmModel)) s.llmModel = defaultChatModel(next);
                  if (next === "mistral" && !LLM_MODELS.some((m) => m.id === s.llmModel)) {
                    s.llmModel = defaultChatModel("mistral");
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
            name: "LM Studio URL",
            desc: "Developer server. Default http://127.0.0.1:1234/v1",
            visible: () => this.plugin.settings.chatProvider === "lmstudio",
            control: { type: "text", key: "lmStudioUrl", placeholder: DEFAULT_CHAT_URL.lmstudio },
          },
          {
            name: "Chat model",
            visible: () => this.plugin.settings.chatProvider === "mistral",
            control: { type: "dropdown", key: "llmModel", options: choiceMap(LLM_MODELS) },
          },
          {
            name: "Chat model",
            desc: "Must be loaded. Refresh lists /v1/models.",
            visible: () => this.plugin.settings.chatProvider !== "mistral",
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
            name: "Speech to text",
            desc: "Mistral Voxtral, or this computer’s recognizer.",
            render: (setting: Setting) => {
              dropdown(setting, SPEECH_PROVIDERS, s.sttProvider, async (v) => {
                await save(() => (s.sttProvider = v as SpeechProvider));
                this.update();
              });
            },
          },
          {
            name: "STT model",
            visible: () => this.plugin.settings.sttProvider === "mistral",
            control: { type: "dropdown", key: "sttModel", options: choiceMap(STT_MODELS) },
          },
          {
            name: "Text to speech",
            desc: "Mistral Voxtral, or this computer’s voice.",
            render: (setting: Setting) => {
              dropdown(setting, SPEECH_PROVIDERS, s.ttsProvider, async (v) => {
                await save(() => (s.ttsProvider = v as SpeechProvider));
                this.update();
              });
            },
          },
          {
            name: "TTS model",
            visible: () => this.plugin.settings.ttsProvider === "mistral",
            control: { type: "dropdown", key: "ttsModel", options: choiceMap(TTS_MODELS) },
          },
          {
            name: "Voice",
            desc:
              this.plugin.settings.ttsProvider === "mistral"
                ? "Spoken replies use this Voxtral voice."
                : "Uses this computer’s default voice.",
            render: (setting: Setting) => {
              const cur = this.plugin.settings;
              if (cur.ttsProvider === "mistral") dropdown(setting, TTS_VOICES, cur.ttsVoice, (v) => save(() => (cur.ttsVoice = v)));
              setting.addExtraButton((btn) =>
                btn
                  .setIcon("play")
                  .setTooltip("Play sample")
                  .onClick(async () => {
                    try {
                      const io = new VoiceIO(() => this.plugin.settings, () => this.plugin.mistralKey());
                      await io.speak("Hi. This is how I sound.");
                    } catch (err) {
                      new Notice(err instanceof Error ? err.message : String(err));
                    }
                  })
              );
            },
          },
          {
            name: "API key",
            desc: "From console.mistral.ai. Leave empty to use MISTRAL_API_KEY in a vault .env file.",
            visible: () => usesMistral(this.plugin.settings),
            render: (setting: Setting) => {
              const cur = this.plugin.settings;
              setting.addText((t) => {
                t.inputEl.type = "password";
                t.setPlaceholder("mistral-…");
                t.setValue(cur.apiKey).onChange((v) => save(() => (cur.apiKey = v.trim())));
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
            desc: "Theme follows Appearance. Or pick a color for the mic, buttons, and chat.",
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
          { name: "Keep listening", desc: "After each reply, listen again until you stop.", control: { type: "toggle", key: "keepListening" } },
          { name: "Hide chat", desc: "Mic only. No transcript — useful if you just want notes edited.", control: { type: "toggle", key: "hideChat" } },
        ],
      },
      {
        type: "group" as const,
        heading: "Dictation",
        items: [
          {
            name: "Dictation",
            desc: "Speech to text into the open note — no chat, no spoken reply. Click a heading or place the cursor; the section highlights. Fn on Mac (set Globe key to Fn). Bind Dictate into note in Hotkeys.",
            control: { type: "toggle", key: "dictation" },
          },
        ],
      },
      {
        type: "group" as const,
        heading: "Tools",
        items: [
          { name: "Tool calls", desc: "Let the model list/read/edit notes and use other tools. Off = talk only.", control: { type: "toggle", key: "allowTools" } },
          { name: "Read only", desc: "Block create, edit, and delete even if those toggles are on.", control: { type: "toggle", key: "readOnly" } },
          { name: "List notes", control: { type: "toggle", key: "allowList" } },
          { name: "Read notes", control: { type: "toggle", key: "allowRead" } },
          { name: "Create notes", control: { type: "toggle", key: "allowCreate" } },
          { name: "Edit notes", control: { type: "toggle", key: "allowEdit" } },
          { name: "Delete notes", desc: "Moves markdown notes to the Obsidian trash. Off by default.", control: { type: "toggle", key: "allowDelete" } },
          { name: "Use internet", desc: "Allow fetching a public http(s) page as text.", control: { type: "toggle", key: "allowInternet" } },
          { name: "Open after write", desc: "Open a note after the agent creates or edits it.", control: { type: "toggle", key: "openAfterWrite" } },
          { name: "Active file only", desc: "File tools may touch only the note that is open.", control: { type: "toggle", key: "activeFileOnly" } },
          { name: "Notes folder", desc: "Limit file tools to this folder. Empty = whole vault.", control: { type: "text", key: "notesFolder", placeholder: "e.g. Notes" } },
        ],
      },
      {
        type: "group" as const,
        heading: "Agent",
        items: [
          { name: "Personality note", desc: "Vault path read each turn for tone and style. Empty = skip.", control: { type: "text", key: "personalityFile", placeholder: "Personality.md" } },
          {
            name: "System prompt",
            desc: "{{date}} and {{file}} are filled in each turn.",
            control: { type: "textarea", key: "systemPrompt", rows: 10 },
          },
          {
            name: "Context notes",
            desc: "Vault paths, one per line. Compacted and appended to the system prompt each turn.",
            control: { type: "textarea", key: "contextNotes", placeholder: "AGENTS.md\nJonas.md", rows: 4 },
          },
        ],
      },
    ] as ReturnType<PluginSettingTab["getSettingDefinitions"]>;
  }
}
