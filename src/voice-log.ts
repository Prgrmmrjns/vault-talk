import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";

const ID_OK = /^[a-z0-9]{4,64}$/;
const AUDIO_TYPES = new Set([
  "response.output_audio.delta",
  "response.audio.delta",
  "input_audio_buffer.append",
]);

export function voiceSessionId(): string {
  const a = new Uint8Array(4);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function cut(s: string): string {
  return s.length > 400 ? `${s.slice(0, 400)}…[${s.length} chars]` : s;
}

function redact(v: unknown, depth = 0): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return cut(v);
  if (depth > 4) return "[depth]";
  if (Array.isArray(v)) {
    const slice = v.slice(0, 50).map((x) => redact(x, depth + 1));
    return v.length > 50 ? [...slice, `…[${v.length}]`] : slice;
  }
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if ((k === "delta" || k === "audio") && typeof val === "string") {
      try {
        out.bytes = atob(val).length;
      } catch {
        out.bytes = val.length;
      }
      continue;
    }
    out[k] = redact(val, depth + 1);
  }
  return out;
}

export class VoiceLogger {
  private buf: Record<string, unknown>[] = [];
  private t0 = Date.now();
  private timer = 0;
  private closed = false;

  constructor(
    private sessionId: string,
    private dir: string
  ) {}

  log(kind: string, data: Record<string, unknown> = {}) {
    if (this.closed) return;
    this.buf.push({ ...redact(data) as Record<string, unknown>, t: Date.now() - this.t0, ts: Date.now(), kind });
    if (this.buf.length >= 200) this.flush();
    else if (!this.timer) this.timer = window.setTimeout(() => this.flush(), 1000);
  }

  client(event: Record<string, unknown>) {
    if (AUDIO_TYPES.has(String(event.type || ""))) return;
    this.log("client", event);
  }

  server(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    if (AUDIO_TYPES.has(String(event.type || ""))) return;
    this.log("server", { ...event, ...extra });
  }

  error(where: string, err: unknown, extra: Record<string, unknown> = {}) {
    const e = err instanceof Error ? err : new Error(String(err));
    this.log("error", { where, name: e.name, message: e.message, ...extra });
  }

  flush() {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    if (!this.buf.length || !ID_OK.test(this.sessionId)) return;
    const rows = this.buf.splice(0, 500).filter((e) => JSON.stringify(e).length < 16000);
    if (!rows.length) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `${this.sessionId}.ndjson`), rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch {
      /* logging never throws into the voice path */
    }
  }

  close() {
    this.closed = true;
    this.flush();
  }
}
