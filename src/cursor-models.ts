export type ModelParamValue = { value: string; displayName?: string };
export type ModelParam = { id: string; displayName?: string; values: ModelParamValue[] };
export type ModelVariant = { params: { id: string; value: string }[]; displayName: string; isDefault?: boolean };
export type CursorModel = {
  id: string;
  displayName: string;
  aliases?: string[];
  parameters?: ModelParam[];
  variants?: ModelVariant[];
};

const THINK = new Set(["reasoning_effort", "effort", "reasoning"]);

export function cleanLabel(s: string | undefined, fallback: string): string {
  const t = (s || "").replace(/\u200b/g, "").trim();
  return t || fallback;
}

export function findModel(models: CursorModel[], id: string): CursorModel | undefined {
  const key = id === "auto" ? "default" : id;
  return models.find((m) => m.id === key || m.aliases?.includes(id) || m.aliases?.includes(key));
}

export function thinkingParam(m: CursorModel | undefined): ModelParam | undefined {
  return m?.parameters?.find((p) => THINK.has(p.id));
}

export function fastParam(m: CursorModel | undefined): ModelParam | undefined {
  return m?.parameters?.find((p) => p.id === "fast");
}

export function thinkSwitch(m: CursorModel | undefined): ModelParam | undefined {
  return m?.parameters?.find((p) => p.id === "thinking");
}

export function contextParam(m: CursorModel | undefined): ModelParam | undefined {
  return m?.parameters?.find((p) => p.id === "context");
}

export function defaultParams(m: CursorModel): Record<string, string> {
  const variant = m.variants?.find((v) => v.isDefault) || m.variants?.[0];
  const out: Record<string, string> = {};
  if (variant) {
    for (const p of variant.params) out[p.id] = p.value;
    return out;
  }
  for (const p of m.parameters || []) {
    const first = p.values[0];
    if (first) out[p.id] = first.value;
  }
  return out;
}

export function clampParams(m: CursorModel, saved: Record<string, string> | undefined): Record<string, string> {
  const out = defaultParams(m);
  for (const p of m.parameters || []) {
    const v = saved?.[p.id];
    if (v && p.values.some((x) => x.value === v)) out[p.id] = v;
  }
  return out;
}

export function paramList(params: Record<string, string>): { id: string; value: string }[] {
  return Object.entries(params).map(([id, value]) => ({ id, value }));
}

function vals(id: string, pairs: [string, string][]): ModelParam {
  return { id, displayName: id, values: pairs.map(([value, displayName]) => ({ value, displayName })) };
}

const effort = (id: string): ModelParam =>
  vals(id, [
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra High"],
    ["max", "Max"],
  ]);

const fast: ModelParam = {
  id: "fast",
  displayName: "Fast",
  values: [
    { value: "false" },
    { value: "true", displayName: "Fast" },
  ],
};

const ctx = (a: string, b: string): ModelParam =>
  vals("context", [
    [a, a.toUpperCase()],
    [b, b.toUpperCase()],
  ]);

/** Used until Cursor.models.list returns the account catalog. */
export const FALLBACK_MODELS: CursorModel[] = [
  { id: "default", displayName: "Auto", aliases: ["auto"], variants: [{ params: [], displayName: "Auto", isDefault: true }] },
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    parameters: [ctx("256k", "500k"), effort("reasoning_effort"), fast],
    variants: [{ params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }], displayName: "Grok 4.7 High Fast", isDefault: true }],
  },
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    parameters: [ctx("300k", "1m"), effort("effort"), fast],
    variants: [{ params: [{ id: "context", value: "1m" }, { id: "effort", value: "medium" }, { id: "fast", value: "false" }], displayName: "Claude Opus 5.5", isDefault: true }],
  },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    parameters: [ctx("300k", "1m"), effort("reasoning_effort")],
    variants: [{ params: [{ id: "context", value: "1m" }, { id: "reasoning_effort", value: "high" }], displayName: "Claude Sonnet 5.5 High", isDefault: true }],
  },
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [fast],
    variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2.5", isDefault: true }],
  },
];
