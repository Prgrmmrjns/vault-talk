import { requestUrl } from "obsidian";
import type { LMVoiceSettings } from "./settings";
import {
  ANTHROPIC_CHAT_MODELS,
  CURSOR_MODELS,
  GEMINI_CHAT_MODELS,
  MISTRAL_CHAT_MODELS,
  OPENAI_CHAT_MODELS,
  type VoiceOption,
} from "./voices";

export type ChatProvider = "cursor" | "ollama" | "openai" | "anthropic" | "google" | "mistral";
export type SttProvider = "grok" | "openai" | "google" | "whisper" | "mistral";
export type TtsProvider = "grok" | "openai" | "google" | "kokoro" | "mistral";
/** @deprecated use SttProvider / TtsProvider */
export type SpeechProvider = SttProvider | TtsProvider;

export const CHAT_PROVIDERS: { id: ChatProvider; label: string }[] = [
  { id: "cursor", label: "Cursor" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Gemini" },
  { id: "mistral", label: "Mistral" },
  { id: "ollama", label: "Ollama" },
];

export const STT_PROVIDERS: { id: SttProvider; label: string }[] = [
  { id: "grok", label: "Grok" },
  { id: "openai", label: "ChatGPT" },
  { id: "google", label: "Google" },
  { id: "whisper", label: "Whisper (local)" },
  { id: "mistral", label: "Mistral" },
];

export const TTS_PROVIDERS: { id: TtsProvider; label: string }[] = [
  { id: "grok", label: "Grok Voice" },
  { id: "openai", label: "ChatGPT Voice" },
  { id: "google", label: "Google Live" },
  { id: "kokoro", label: "Kokoro (local)" },
  { id: "mistral", label: "Mistral" },
];

export function isDuplexTalk(p: TtsProvider): boolean {
  return p === "grok" || p === "openai" || p === "google";
}

export const SPEECH_PROVIDERS = STT_PROVIDERS;

export const DEFAULT_CHAT_URL: Record<"ollama", string> = {
  ollama: "http://127.0.0.1:11434/v1",
};

export const DEFAULT_WHISPER_URL = "http://127.0.0.1:9000/v1";
export const DEFAULT_KOKORO_URL = "http://127.0.0.1:8880/v1";
export const MISTRAL_API = "https://api.mistral.ai/v1";
export const OPENAI_API = "https://api.openai.com/v1";
export const ANTHROPIC_API = "https://api.anthropic.com/v1";
export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

export function openaiRoot(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(u) ? u : `${u}/v1`;
}

export function chatModels(provider: ChatProvider): VoiceOption[] {
  if (provider === "cursor") return CURSOR_MODELS;
  if (provider === "openai") return OPENAI_CHAT_MODELS;
  if (provider === "anthropic") return ANTHROPIC_CHAT_MODELS;
  if (provider === "google") return GEMINI_CHAT_MODELS;
  if (provider === "mistral") return MISTRAL_CHAT_MODELS;
  return [];
}

export function chatRoot(s: LMVoiceSettings): string {
  if (s.chatProvider === "openai") return OPENAI_API;
  if (s.chatProvider === "mistral") return MISTRAL_API;
  if (s.chatProvider === "ollama") return openaiRoot(s.ollamaUrl || DEFAULT_CHAT_URL.ollama);
  throw new Error("This chat provider does not use an OpenAI-compatible URL.");
}

export function defaultChatModel(provider: ChatProvider): string {
  if (provider === "ollama") return "llama3.2";
  const first = chatModels(provider)[0];
  return first?.id || "composer-2.5";
}

export async function listChatModels(s: LMVoiceSettings): Promise<string[]> {
  const known = chatModels(s.chatProvider).map((m) => m.id);
  if (s.chatProvider !== "ollama") return known;
  const res = await requestUrl({
    url: `${chatRoot(s)}/models`,
    method: "GET",
    headers: { "Content-Type": "application/json" },
    throw: false,
  });
  if (res.status >= 300) throw new Error(`Models ${res.status}: ${(res.text || "").slice(0, 160)}`);
  const json = parseJson(res);
  const data = json.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => (row && typeof row === "object" && "id" in row ? String((row as { id: unknown }).id) : ""))
    .filter(Boolean);
}

export function parseJson(res: { json: unknown; text: string }): Record<string, unknown> {
  if (res.json && typeof res.json === "object") return res.json as Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(res.text || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
