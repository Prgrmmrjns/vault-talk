export interface VoiceOption {
  id: string;
  label: string;
}

export const GROK_VOICES: VoiceOption[] = [
  { id: "eve", label: "Eve" },
  { id: "ara", label: "Ara" },
  { id: "rex", label: "Rex" },
  { id: "sal", label: "Sal" },
  { id: "leo", label: "Leo" },
];

export const KOKORO_VOICES: VoiceOption[] = [
  { id: "af_heart", label: "Heart" },
  { id: "af_bella", label: "Bella" },
  { id: "af_nicole", label: "Nicole" },
  { id: "am_michael", label: "Michael" },
  { id: "am_fenrir", label: "Fenrir" },
  { id: "bf_emma", label: "Emma" },
  { id: "bm_george", label: "George" },
];

export const OPENAI_VOICES: VoiceOption[] = [
  { id: "marin", label: "Marin" },
  { id: "cedar", label: "Cedar" },
  { id: "alloy", label: "Alloy" },
  { id: "echo", label: "Echo" },
  { id: "shimmer", label: "Shimmer" },
  { id: "ash", label: "Ash" },
  { id: "ballad", label: "Ballad" },
  { id: "coral", label: "Coral" },
  { id: "sage", label: "Sage" },
  { id: "verse", label: "Verse" },
];

export const GOOGLE_VOICES: VoiceOption[] = [
  { id: "Kore", label: "Kore" },
  { id: "Puck", label: "Puck" },
  { id: "Charon", label: "Charon" },
  { id: "Fenrir", label: "Fenrir" },
  { id: "Aoede", label: "Aoede" },
  { id: "Leda", label: "Leda" },
  { id: "Orus", label: "Orus" },
  { id: "Zephyr", label: "Zephyr" },
];

export const MISTRAL_VOICES: VoiceOption[] = [
  { id: "gb_jane_neutral", label: "Jane" },
  { id: "gb_ryan_neutral", label: "Ryan" },
  { id: "us_ava_neutral", label: "Ava" },
  { id: "us_dustin_neutral", label: "Dustin" },
];

export const CURSOR_MODELS = [
  { id: "composer-2.5", label: "Composer 2.5" },
  { id: "auto", label: "Auto" },
];

export const OPENAI_CHAT_MODELS: VoiceOption[] = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4o", label: "GPT-4o" },
];

export const ANTHROPIC_CHAT_MODELS: VoiceOption[] = [
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

export const GEMINI_CHAT_MODELS: VoiceOption[] = [
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
];

export const MISTRAL_CHAT_MODELS: VoiceOption[] = [
  { id: "mistral-medium-latest", label: "Medium" },
  { id: "mistral-large-latest", label: "Large" },
  { id: "mistral-small-latest", label: "Small" },
];
