// Opus encode/decode for cached stems, via WebCodecs — ~12× smaller than WAV in
// R2 with NO real-time penalty (the reason MediaRecorder was abandoned) and NO
// codec dependency. Works on Chrome/Edge/Firefox and Safari/iOS 16.4+.
//
// SELF-DESCRIBING: every encoded blob starts with a 12-byte header (magic "HTO1"
// + sample rate + channels), so the decoder routes Opus vs WAV by inspecting the
// bytes — no manifest/content-type coupling. Anything unsupported falls back to
// WAV on encode and to the caller's DSP path on decode, so this can NEVER break
// stems: worst case a device just doesn't get the smaller format.
//
// NOTE: Opus only runs at 8/12/16/24/48 kHz, so stems are resampled to 48 kHz for
// storage. On playback an AudioBufferSourceNode resamples to the deck's context
// rate automatically. Neural stems are estimates (they don't sum bit-exact to the
// mix anyway), so this is fine; the bit-exact DSP split never takes this path.

const MAGIC = 0x48544f31; // "HTO1"
const OPUS_SR = 48000;
const BITRATE = 128_000; // per stem; near-transparent, ~1 MB/min

let _supported: Promise<boolean> | null = null;
/** Whether this browser can both encode AND decode Opus via WebCodecs. Cached. */
export function opusStemsSupported(): Promise<boolean> {
  if (_supported) return _supported;
  _supported = (async () => {
    try {
      const g = globalThis as unknown as {
        AudioEncoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> };
        AudioDecoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> };
      };
      if (!g.AudioEncoder || !g.AudioDecoder) return false;
      const e = await g.AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: OPUS_SR, numberOfChannels: 2, bitrate: BITRATE });
      const d = await g.AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: OPUS_SR, numberOfChannels: 2 });
      return !!(e.supported && d.supported);
    } catch {
      return false;
    }
  })();
  return _supported;
}

/** True if these bytes are an htl-Opus blob (vs WAV / anything else). */
export function isOpusStem(bytes: ArrayBuffer): boolean {
  return bytes.byteLength >= 12 && new DataView(bytes).getUint32(0, false) === MAGIC;
}

async function to48k(buffer: AudioBuffer): Promise<AudioBuffer> {
  if (buffer.sampleRate === OPUS_SR) return buffer;
  const off = new OfflineAudioContext(buffer.numberOfChannels, Math.max(1, Math.ceil(buffer.duration * OPUS_SR)), OPUS_SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

/** Encode an AudioBuffer to the htl-Opus container. Throws if WebCodecs/Opus is unavailable. */
export async function encodeStemOpus(buffer: AudioBuffer): Promise<ArrayBuffer> {
  const buf = await to48k(buffer);
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const planar = new Float32Array(len * ch);
  for (let c = 0; c < ch; c++) planar.set(buf.getChannelData(c), c * len);

  const packets: Uint8Array[] = [];
  let total = 0;
  const W = globalThis as unknown as { AudioEncoder: new (i: unknown) => Encoder; AudioData: new (i: unknown) => AudioDataLike };
  const enc = new W.AudioEncoder({
    output: (chunk: EncodedChunkLike) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      packets.push(b);
      total += 4 + b.byteLength;
    },
    error: (e: Error) => {
      throw e;
    },
  });
  enc.configure({ codec: "opus", sampleRate: OPUS_SR, numberOfChannels: ch, bitrate: BITRATE });

  const FR = OPUS_SR; // 1-second AudioData frames
  let ts = 0;
  for (let o = 0; o < len; o += FR) {
    const n = Math.min(FR, len - o);
    const frame = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) frame.set(planar.subarray(c * len + o, c * len + o + n), c * n);
    const ad = new W.AudioData({ format: "f32-planar", sampleRate: OPUS_SR, numberOfFrames: n, numberOfChannels: ch, timestamp: ts, data: frame });
    enc.encode(ad);
    ad.close();
    ts += Math.round((n / OPUS_SR) * 1e6);
  }
  await enc.flush();
  enc.close();

  const out = new Uint8Array(12 + total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, false);
  dv.setUint32(4, OPUS_SR, true);
  out[8] = ch;
  let p = 12;
  for (const pk of packets) {
    dv.setUint32(p, pk.byteLength, true);
    p += 4;
    out.set(pk, p);
    p += pk.byteLength;
  }
  return out.buffer;
}

/** Decode an htl-Opus blob back to an AudioBuffer. Throws on any failure (caller falls back). */
export async function decodeStemOpus(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  const dv = new DataView(bytes);
  const sr = dv.getUint32(4, true);
  const ch = new Uint8Array(bytes)[8] || 2;
  const frames: AudioDataLike[] = [];
  const W = globalThis as unknown as { AudioDecoder: new (i: unknown) => Decoder; EncodedAudioChunk: new (i: unknown) => unknown };
  const dec = new W.AudioDecoder({
    output: (d: AudioDataLike) => frames.push(d),
    error: (e: Error) => {
      throw e;
    },
  });
  dec.configure({ codec: "opus", sampleRate: sr, numberOfChannels: ch });

  let p = 12;
  let ts = 0;
  while (p + 4 <= bytes.byteLength) {
    const len = dv.getUint32(p, true);
    p += 4;
    if (len <= 0 || p + len > bytes.byteLength) break;
    dec.decode(new W.EncodedAudioChunk({ type: "key", timestamp: ts, data: new Uint8Array(bytes, p, len) }));
    p += len;
    ts += 20_000; // ordering only; real durations come from the decoded frames
  }
  await dec.flush();
  dec.close();

  const totalFrames = frames.reduce((a, d) => a + d.numberOfFrames, 0);
  const out = ctx.createBuffer(ch, Math.max(1, totalFrames), sr);
  for (let c = 0; c < ch; c++) {
    const dest = out.getChannelData(c);
    let o = 0;
    for (const d of frames) {
      const tmp = new Float32Array(d.numberOfFrames);
      d.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
      dest.set(tmp, o);
      o += d.numberOfFrames;
    }
  }
  for (const d of frames) d.close();
  return out;
}

// Minimal structural types for the WebCodecs surface we touch (avoids depending on
// lib.dom WebCodecs typings being present).
interface EncodedChunkLike {
  byteLength: number;
  copyTo(dst: Uint8Array): void;
}
interface AudioDataLike {
  numberOfFrames: number;
  copyTo(dst: Float32Array, opts: { planeIndex: number; format: string }): void;
  close(): void;
}
interface Encoder {
  configure(c: unknown): void;
  encode(d: AudioDataLike): void;
  flush(): Promise<void>;
  close(): void;
}
interface Decoder {
  configure(c: unknown): void;
  decode(c: unknown): void;
  flush(): Promise<void>;
  close(): void;
}
