import { requestUrl } from "obsidian";
import type { LMVoiceSettings } from "./settings";

export type ChatProvider = "ollama" | "cursor";
export type SttProvider = "grok" | "whisper" | "mistral";
export type TtsProvider = "grok" | "kokoro" | "mistral";
/** @deprecated use SttProvider / TtsProvider */
export type SpeechProvider = SttProvider | TtsProvider;

export const CHAT_PROVIDERS: { id: ChatProvider; label: string }[] = [
  { id: "cursor", label: "Cursor" },
  { id: "ollama", label: "Ollama" },
];

export const STT_PROVIDERS: { id: SttProvider; label: string }[] = [
  { id: "grok", label: "Grok" },
  { id: "whisper", label: "Whisper (local)" },
  { id: "mistral", label: "Mistral" },
];

export const TTS_PROVIDERS: { id: TtsProvider; label: string }[] = [
  { id: "grok", label: "Grok Voice" },
  { id: "kokoro", label: "Kokoro (local)" },
  { id: "mistral", label: "Mistral" },
];

export const SPEECH_PROVIDERS = STT_PROVIDERS;

export const DEFAULT_CHAT_URL: Record<Exclude<ChatProvider, "cursor">, string> = {
  ollama: "http://127.0.0.1:11434/v1",
};

export const DEFAULT_WHISPER_URL = "http://127.0.0.1:9000/v1";
export const DEFAULT_KOKORO_URL = "http://127.0.0.1:8880/v1";
export const MISTRAL_API = "https://api.mistral.ai/v1";

export function openaiRoot(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(u) ? u : `${u}/v1`;
}

export function chatRoot(s: LMVoiceSettings): string {
  if (s.chatProvider === "cursor") throw new Error("Cursor does not use a chat URL.");
  return openaiRoot(s.ollamaUrl || DEFAULT_CHAT_URL.ollama);
}

export function chatHeaders(_s: LMVoiceSettings): Record<string, string> {
  return { "Content-Type": "application/json" };
}

export function defaultChatModel(provider: ChatProvider): string {
  if (provider === "ollama") return "llama3.2";
  return "composer-2.5";
}

export async function listChatModels(s: LMVoiceSettings): Promise<string[]> {
  if (s.chatProvider === "cursor") return [];
  const res = await requestUrl({
    url: `${chatRoot(s)}/models`,
    method: "GET",
    headers: chatHeaders(s),
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
