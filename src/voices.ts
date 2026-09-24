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
