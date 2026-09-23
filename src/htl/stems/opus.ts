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

/** Decode an htl-Opus blob back to an AudioBuffer on the CALLING thread. Throws on any failure.
 *
 *  ★ THE APP DOES NOT CALL THIS. Since e99f298 the stem path goes through
 *  opusWorker.decodeStemOpusOffThread, which runs the decode in a worker and falls back to
 *  decodeStemOpusPlanes here only when it cannot. This entry survives as stemlab's INLINE
 *  comparison arm — the thing the worker is measured against — and grepping it will find no
 *  production caller, which is correct rather than dead.
 *
 *  `opts` is MEASUREMENT SCAFFOLDING and nothing in the app passes it. The claim that this
 *  mitigation turned a freeze into a stutter was never re-measured after it shipped, and when it
 *  finally was, it went the other way — so both knobs exist so the comparison runs through THIS
 *  code rather than through a reimplementation of it (scripts/stemlab).
 *
 *  `sliceMs` = the yield budget; Infinity is the pre-mitigation shape, no sleep at all.
 *  `yieldTo`  = HOW it gives the thread back. The default is setTimeout(0), and that is the thing
 *  under suspicion: a timer task is DUE, so the browser runs it before it paints — a yield that
 *  does not rank below rendering can starve the very frames the slicing exists to protect. If a
 *  rAF-shaped yield wins the grid, it stops being a parameter and becomes the implementation. */
export async function decodeStemOpus(
  ctx: BaseAudioContext,
  bytes: ArrayBuffer,
  opts: { sliceMs?: number; yieldTo?: () => Promise<void> } = {},
): Promise<AudioBuffer> {
  const { planes, sampleRate } = await decodeStemOpusPlanes(bytes, opts);
  return planesToBuffer(ctx, planes, sampleRate);
}

/** The decode itself, with NO AudioContext anywhere in it — planes of f32 PCM and their rate.
 *
 *  ★ THIS SPLIT IS FORCED, NOT CHOSEN (task #132). AudioDecoder and Opus work inside a Worker;
 *  AudioContext and OfflineAudioContext do not exist there. So the expensive half — feeding packets
 *  and copying ~12,000 frames' planes per stem — can move off the main thread, and only the cheap
 *  assembly (createBuffer + a resample when the context rate differs) has to stay on it. Everything
 *  below this line is deliberately free of `ctx`. */
export async function decodeStemOpusPlanes(
  bytes: ArrayBuffer,
  opts: { sliceMs?: number; yieldTo?: () => Promise<void> } = {},
): Promise<{ planes: Float32Array[]; sampleRate: number }> {
  const sliceMs = opts.sliceMs ?? 8;
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

  // ★ THE SLICING BELOW IS NOW THE FALLBACK'S CONCERN ONLY, and this comment used to say otherwise.
  // The app decodes through a WORKER (opusWorker.decodeStemOpusOffThread, e99f298); this function
  // runs on whatever thread called it, which in production means the worker, and on the main thread
  // only when the worker could not be constructed, died, or went silent. Off the main thread there
  // is nothing to give back, so the worker passes sliceMs: Infinity.
  //
  // HISTORY, because the numbers are still the reason the yield exists at all: four stems decode on
  // every song load, and both loops here — feeding packets in, copying planes out — used to run
  // start to finish without once yielding. Measured at 4x CPU with a real track loading, this was
  // the largest single piece of app code on the song-change path and the load window carried a
  // 1.4-SECOND frame: one frozen picture, mid-set.
  //
  // Slicing on ELAPSED TIME rather than a packet or frame count is deliberate, for the reason
  // buildStemPyramidsLazy spells out: a fixed count is a guess about machine speed that is wrong
  // in the direction that hurts, because the slower the device the longer each fixed chunk blocks
  // it. A clock cuts the chunk down until it fits, on whatever hardware is actually running.
  //
  // ★ AND THE 8 ms DEFAULT IS MEASURABLY THE WORST OF THE AVAILABLE YIELDS, kept anyway. stemlab
  // showed setTimeout(0) costs ~3.5x the blocking of scheduler.yield or postTask(user-blocking),
  // because those resume AHEAD of work queued during the sleep and a timer resumes behind it
  // (b18a3dac). It is not switched because whether iOS — the only platform that reaches this
  // fallback in anger — exposes either API is unmeasured, and the fallback from an absent API is
  // this timer. Thread 9d03d3e1 carries that probe.
  const SLICE_MS = sliceMs; // 8 ms by default: under a frame, so a decode in flight cannot drop one
  const breathe = opts.yieldTo ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  let slice = performance.now();

  let p = 12;
  let ts = 0;
  while (p + 4 <= bytes.byteLength) {
    const len = dv.getUint32(p, true);
    p += 4;
    if (len <= 0 || p + len > bytes.byteLength) break;
    dec.decode(new W.EncodedAudioChunk({ type: "key", timestamp: ts, data: new Uint8Array(bytes, p, len) }));
    p += len;
    ts += 20_000; // ordering only; real durations come from the decoded frames
    if (performance.now() - slice > SLICE_MS) {
      await breathe();
      slice = performance.now();
    }
  }
  await dec.flush();
  dec.close();

  const totalFrames = frames.reduce((a, d) => a + d.numberOfFrames, 0);
  const planes: Float32Array[] = [];
  for (let c = 0; c < ch; c++) planes.push(new Float32Array(Math.max(1, totalFrames)));
  // ★ COPY STRAIGHT INTO THE DESTINATION, not via a scratch array per frame. Opus decodes in
  // small frames, so a 4-minute stem is on the order of 12,000 of them — and the old shape
  // allocated a Float32Array and made a SECOND copy for every one of them, per channel. That is
  // ~24,000 short-lived allocations per stem and four stems per track, all on the main thread,
  // all on the load path. A subarray is a view, not a copy: copyTo writes the plane where it
  // finally belongs, once. (copyTo requires the destination to be exactly plane-sized, which is
  // what the subarray bounds give it.)
  slice = performance.now();
  for (let c = 0; c < ch; c++) {
    const dest = planes[c];
    let o = 0;
    for (const d of frames) {
      d.copyTo(dest.subarray(o, o + d.numberOfFrames), { planeIndex: c, format: "f32-planar" });
      o += d.numberOfFrames;
      if (performance.now() - slice > SLICE_MS) {
        await breathe();
        slice = performance.now();
      }
    }
  }
  for (const d of frames) d.close();
  return { planes, sampleRate: sr };
}

/** Wrap decoded planes as an AudioBuffer for THIS context — the only part that needs one. */
export async function planesToBuffer(ctx: BaseAudioContext, planes: Float32Array[], sr: number): Promise<AudioBuffer> {
  const ch = planes.length;
  const out = ctx.createBuffer(ch, Math.max(1, planes[0]?.length ?? 1), sr);
  for (let c = 0; c < ch; c++) out.getChannelData(c).set(planes[c]);
  // Opus is ALWAYS stored at OPUS_SR (48 kHz). The stretch engine plays every PCM source at
  // the AudioContext's sample rate — the mix gets there via decodeAudioData — so if the
  // context runs at a different rate, these stems would play pitched + sped by
  // ctx.sampleRate / OPUS_SR. That's the "supplementary stems break pitch & tempo on mobile"
  // bug: iOS follows the output route and is often 44.1 kHz (≈0.919× → ~1.5 semitones flat,
  // ~8% slow), while desktop Chrome at 48 kHz happens to match. Resample to the context rate
  // so the stems line up with the mix (the WAV path already does, via decodeAudioData).
  if (sr === ctx.sampleRate) return out;
  const off = new OfflineAudioContext(ch, Math.max(1, Math.ceil(out.duration * ctx.sampleRate)), ctx.sampleRate);
  const node = off.createBufferSource();
  node.buffer = out;
  node.connect(off.destination);
  node.start();
  return off.startRendering();
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
