import { requestUrl } from "obsidian";
import type { LMVoiceSettings } from "./settings";

export type ChatProvider = "mistral" | "ollama" | "lmstudio";
export type SpeechProvider = "mistral" | "browser";

export const CHAT_PROVIDERS: { id: ChatProvider; label: string }[] = [
  { id: "mistral", label: "Mistral" },
  { id: "ollama", label: "Ollama" },
  { id: "lmstudio", label: "LM Studio" },
];

export const SPEECH_PROVIDERS: { id: SpeechProvider; label: string }[] = [
  { id: "mistral", label: "Mistral (Voxtral)" },
  { id: "browser", label: "This computer" },
];

export const DEFAULT_CHAT_URL: Record<ChatProvider, string> = {
  mistral: "https://api.mistral.ai/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};

export function usesMistral(s: LMVoiceSettings): boolean {
  return s.chatProvider === "mistral" || s.sttProvider === "mistral" || s.ttsProvider === "mistral";
}

function openaiRoot(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(u) ? u : `${u}/v1`;
}

export function chatRoot(s: LMVoiceSettings): string {
  if (s.chatProvider === "ollama") return openaiRoot(s.ollamaUrl || DEFAULT_CHAT_URL.ollama);
  if (s.chatProvider === "lmstudio") return openaiRoot(s.lmStudioUrl || DEFAULT_CHAT_URL.lmstudio);
  return DEFAULT_CHAT_URL.mistral;
}

export function chatHeaders(s: LMVoiceSettings, mistralKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.chatProvider === "mistral") headers.Authorization = "Bearer " + mistralKey;
  else if (s.chatProvider === "lmstudio") headers.Authorization = "Bearer lm-studio";
  return headers;
}

export function defaultChatModel(provider: ChatProvider): string {
  if (provider === "ollama") return "llama3.2";
  if (provider === "lmstudio") return "";
  return "mistral-small-latest";
}

export async function listChatModels(s: LMVoiceSettings): Promise<string[]> {
  const res = await requestUrl({
    url: `${chatRoot(s)}/models`,
    method: "GET",
    headers: chatHeaders(s, ""),
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
