import { requestUrl } from "obsidian";
import { parseJson } from "./providers";
import { txt } from "./txt";

export const REALTIME_STT = "voxtral-mini-transcribe-realtime-2602";
const API = "https://api.mistral.ai/v1";
const WS = "wss://api.mistral.ai/v1/audio/transcriptions/realtime";
const RATE = 16000;

export type LiveHandlers = {
  onText: (full: string) => void;
  onLevel?: (rms: number) => void;
  onVad?: (speaking: boolean) => void;
  onError?: (msg: string) => void;
};

export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const n = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.min(Math.floor(x), input.length - 1);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = x - i0;
    out[i] = (input[i0] ?? 0) * (1 - f) + (input[i1] ?? 0) * f;
  }
  return out;
}

export function pcm16le(f32: Float32Array): Uint8Array {
  const out = new Uint8Array(f32.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s);
}

export function rms(f32: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < f32.length; i++) {
    const x = f32[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum / Math.max(1, f32.length));
}

export async function mintRealtimeToken(key: string, model = REALTIME_STT): Promise<string> {
  const res = await requestUrl({
    url: `${API}/client/sessions`,
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "realtime", model }),
    throw: false,
  });
  if (res.status >= 300) throw new Error(`STT session ${res.status}: ${(res.text || "").slice(0, 180)}`);
  const json = parseJson(res);
  const secret = json.client_secret;
  const token =
    (secret && typeof secret === "object" && "value" in secret ? txt((secret as { value?: unknown }).value) : "") ||
    txt(json.token);
  if (!token.startsWith("rt_")) throw new Error("No realtime token");
  return token;
}

function deltaText(msg: Record<string, unknown>): string {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.delta === "string") return msg.delta;
  const d = msg.delta;
  if (d && typeof d === "object" && typeof (d as { text?: unknown }).text === "string") {
    return (d as { text: string }).text;
  }
  return "";
}

export async function streamRealtime(
  stream: MediaStream,
  key: string,
  handlers: LiveHandlers,
  flags: { cancelled: () => boolean; stopping: () => boolean }
): Promise<string> {
  const token = await mintRealtimeToken(key);
  const model = REALTIME_STT;
  const ws = new WebSocket(`${WS}?model=${encodeURIComponent(model)}&target_streaming_delay_ms=480`, ["realtime", token]);
  let full = "";
  let dead: Error | null = null;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  await new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error("Realtime STT timeout")), 8000);
    ws.onopen = () => {
      window.clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      window.clearTimeout(t);
      reject(new Error("Realtime STT socket failed"));
    };
  });

  ws.onmessage = (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = txt(msg.type);
    if (type === "session.created") {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            audio_format: { encoding: "pcm_s16le", sample_rate: RATE },
            target_streaming_delay_ms: 480,
          },
        })
      );
      return;
    }
    if (type === "transcription.text.delta") {
      const bit = deltaText(msg);
      if (!bit) return;
      full += bit;
      handlers.onText(full);
      return;
    }
    if (type === "transcription.done") {
      const bit = deltaText(msg);
      if (bit) {
        full += bit;
        handlers.onText(full);
      }
      done();
      return;
    }
    if (type === "error") {
      const err = msg.error;
      const text =
        typeof err === "string"
          ? err
          : err && typeof err === "object" && "message" in err
            ? String((err as { message?: string }).message || "STT error")
            : "STT error";
      dead = new Error(text);
      done();
    }
  };
  ws.onerror = () => {
    dead = new Error("Realtime STT socket failed");
    done();
  };
  ws.onclose = () => done();

  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("AudioContext missing");
  const ctx = new Ctx({ sampleRate: RATE });
  await ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  if (typeof ctx.createScriptProcessor !== "function") throw new Error("AudioContext missing");
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  let loud = 0;
  let quiet = 0;
  let speaking = false;
  proc.onaudioprocess = (e) => {
    if (flags.cancelled() || flags.stopping()) return;
    const raw = e.inputBuffer.getChannelData(0);
    const f32 = resample(raw, ctx.sampleRate, RATE);
    const level = rms(f32);
    handlers.onLevel?.(level);
    if (level > 0.018) {
      loud++;
      quiet = 0;
    } else {
      quiet++;
      loud = 0;
    }
    const next = speaking ? quiet < 10 : loud >= 2;
    if (next !== speaking) {
      speaking = next;
      handlers.onVad?.(speaking);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input_audio.append", audio: bytesToB64(pcm16le(f32)) }));
  };

  const waitStop = async () => {
    while (!flags.cancelled() && !flags.stopping() && !dead) {
      await new Promise((r) => window.setTimeout(r, 80));
    }
  };

  try {
    await waitStop();
    proc.disconnect();
    src.disconnect();
    mute.disconnect();
    await ctx.close().catch(() => {});
    if (dead !== null && !flags.stopping() && !flags.cancelled()) throw new Error("Realtime STT failed");
    if (flags.cancelled()) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      throw new Error("Cancelled");
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input_audio.flush" }));
      ws.send(JSON.stringify({ type: "input_audio.end" }));
    }
    await Promise.race([finished, new Promise((r) => window.setTimeout(r, 2500))]);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return full;
  } finally {
    try {
      proc.disconnect();
    } catch {
      /* ignore */
    }
    await ctx.close().catch(() => {});
  }
}
