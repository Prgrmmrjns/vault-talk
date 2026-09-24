export const RATE_24K = 24000;
export const RATE_16K = 16000;

export const CAP_WORKLET = `class VtCap extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c&&c.length)this.port.postMessage(c.slice());return true}}registerProcessor("vt-cap",VtCap);`;

export function b64enc(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function b64dec(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = to / from;
  const n = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / ratio;
    const i0 = Math.min(Math.floor(x), input.length - 1);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = x - i0;
    out[i] = (input[i0] ?? 0) * (1 - f) + (input[i1] ?? 0) * f;
  }
  return out;
}

export function toPcm16(f32: Float32Array): Uint8Array {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i] ?? 0));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

export function fromPcm16(bytes: Uint8Array): Float32Array {
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 32768;
  return out;
}

export class PcmPlayer {
  private next = 0;
  private nodes: AudioBufferSourceNode[] = [];
  underruns = 0;
  drainMs = 0;
  queuedMs = 0;

  constructor(private ctx: AudioContext) {}

  reset() {
    this.next = this.ctx.currentTime + 0.15;
    this.underruns = 0;
    this.drainMs = 0;
    this.queuedMs = 0;
  }

  push(f32: Float32Array) {
    if (!f32.length) return;
    const buf = this.ctx.createBuffer(1, f32.length, this.ctx.sampleRate);
    buf.copyToChannel(f32 as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.next < now) {
      this.underruns++;
      this.next = now + 0.02;
    }
    const start = this.next;
    src.start(start);
    this.next = start + buf.duration;
    this.queuedMs = Math.max(0, (this.next - now) * 1000);
    this.drainMs = Math.max(this.drainMs, this.queuedMs);
    this.nodes.push(src);
    src.onended = () => {
      this.nodes = this.nodes.filter((n) => n !== src);
    };
  }

  stop(): number {
    const dropped = Math.max(0, (this.next - this.ctx.currentTime) * 1000);
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
      n.disconnect();
    }
    this.nodes = [];
    this.next = 0;
    this.queuedMs = 0;
    return dropped;
  }
}

export async function attachCapture(
  ctx: AudioContext,
  stream: MediaStream,
  onPcm: (pcm: Uint8Array) => void,
  targetRate: number
): Promise<() => void> {
  const src = ctx.createMediaStreamSource(stream);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  const acc: Float32Array[] = [];
  let accN = 0;
  const want = Math.floor(ctx.sampleRate * 0.1);
  const flush = () => {
    if (!accN) return;
    const merged = new Float32Array(accN);
    let o = 0;
    for (const a of acc) {
      merged.set(a, o);
      o += a.length;
    }
    acc.length = 0;
    accN = 0;
    onPcm(toPcm16(resample(merged, ctx.sampleRate, targetRate)));
  };
  const onF32 = (chunk: Float32Array) => {
    acc.push(chunk);
    accN += chunk.length;
    if (accN >= want) flush();
  };
  try {
    const url = URL.createObjectURL(new Blob([CAP_WORKLET], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, "vt-cap");
    node.port.onmessage = (e) => onF32(e.data as Float32Array);
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    return () => {
      flush();
      node.port.onmessage = null;
      node.disconnect();
      src.disconnect();
      mute.disconnect();
    };
  } catch {
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (e) => onF32(e.inputBuffer.getChannelData(0).slice());
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    return () => {
      flush();
      proc.disconnect();
      src.disconnect();
      mute.disconnect();
    };
  }
}

export async function openMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
}

export function audioCtx(rate: number): AudioContext {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new Ctx({ sampleRate: rate });
}
