export interface VoiceOption {
  id: string;
  label: string;
}

export const TTS_VOICES: VoiceOption[] = [
  { id: "en_paul_confident", label: "Paul — confident (US)" },
  { id: "en_paul_neutral", label: "Paul — neutral (US)" },
  { id: "en_paul_cheerful", label: "Paul — cheerful (US)" },
  { id: "en_paul_happy", label: "Paul — happy (US)" },
  { id: "en_paul_excited", label: "Paul — excited (US)" },
  { id: "en_paul_frustrated", label: "Paul — frustrated (US)" },
  { id: "en_paul_sad", label: "Paul — sad (US)" },
  { id: "en_paul_angry", label: "Paul — angry (US)" },
  { id: "gb_oliver_confident", label: "Oliver — confident (UK)" },
  { id: "gb_oliver_neutral", label: "Oliver — neutral (UK)" },
  { id: "gb_oliver_cheerful", label: "Oliver — cheerful (UK)" },
  { id: "gb_oliver_curious", label: "Oliver — curious (UK)" },
  { id: "gb_oliver_excited", label: "Oliver — excited (UK)" },
  { id: "gb_oliver_sad", label: "Oliver — sad (UK)" },
  { id: "gb_oliver_angry", label: "Oliver — angry (UK)" },
  { id: "gb_jane_confident", label: "Jane — confident (UK)" },
  { id: "gb_jane_neutral", label: "Jane — neutral (UK)" },
  { id: "gb_jane_curious", label: "Jane — curious (UK)" },
  { id: "gb_jane_sarcasm", label: "Jane — sarcasm (UK)" },
  { id: "gb_jane_confused", label: "Jane — confused (UK)" },
  { id: "gb_jane_frustrated", label: "Jane — frustrated (UK)" },
  { id: "gb_jane_sad", label: "Jane — sad (UK)" },
  { id: "gb_jane_jealousy", label: "Jane — jealousy (UK)" },
  { id: "gb_jane_shameful", label: "Jane — shameful (UK)" },
  { id: "fr_marie_neutral", label: "Marie — neutral (FR)" },
  { id: "fr_marie_happy", label: "Marie — happy (FR)" },
  { id: "fr_marie_curious", label: "Marie — curious (FR)" },
  { id: "fr_marie_excited", label: "Marie — excited (FR)" },
  { id: "fr_marie_sad", label: "Marie — sad (FR)" },
  { id: "fr_marie_angry", label: "Marie — angry (FR)" },
];

export const LLM_MODELS = [
  { id: "mistral-small-latest", label: "Mistral Small" },
  { id: "mistral-medium-latest", label: "Mistral Medium" },
  { id: "mistral-large-latest", label: "Mistral Large" },
];

export const STT_MODELS = [
  { id: "voxtral-mini-latest", label: "Voxtral Mini" },
  { id: "voxtral-small-latest", label: "Voxtral Small" },
];

export const TTS_MODELS = [{ id: "voxtral-mini-tts-2603", label: "Voxtral Mini TTS" }];
