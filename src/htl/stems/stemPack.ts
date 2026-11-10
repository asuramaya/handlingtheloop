// Streaming int16 stem packer: float32 PCM in, in whatever chunks the decoder hands out, int16 out
// plus the level-0 waveform envelope (min/max + low/mid/high band energy), in ONE pass.
//
// ★ WHY STREAMING. The packed-stem load path used to decode a whole stem to float32 before packing
// it, and the decode itself held the stem twice more on its way there: the Opus worker kept every
// decoded AudioData frame until the end (one full float32 copy), copied them into planes (a second),
// transferred the planes to the main thread, which copied them into an AudioBuffer (a third) before
// the pack read it. For a ten-minute stem that is ~230 MB per copy, ~690 MB in flight for one stem on
// top of everything both decks already hold — the second-deck load transient that kills an iPhone
// tab. Packing each decoded frame as it arrives, and closing the frame straight after, means the
// float32 never exists at full length anywhere: the only full-length allocation is the int16 output
// that the worklet is going to own anyway.
//
// The math is IDENTICAL to Deck's fused pack and the old packStemInt16Full (round-to-nearest,
// symmetric ±32767 clamp; the same one-pole 200 Hz / 2 kHz split and per-bucket RMS), so the audio the
// worklet plays is bit-for-bit what it was and the lanes look the same. The one structural difference
// is that the final partial bucket is flushed in finish() rather than at "i === n - 1", which is the
// same thing said without knowing n in advance.
//
// No DOM or AudioContext in here: it runs in the decode worker and on the main thread alike.

export const PACK_BUCKET = 256; // MUST match STEM_BASE_BUCKET in Deck.ts (the pyramid level-0 bucket)

export interface StemBase {
  min: Float32Array;
  max: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  bucket: number;
}

export interface PackedStem {
  L: Int16Array;
  R: Int16Array;
  /** Samples written (≤ L.length; the rest, if any, is silence padding up to `limit`). */
  length: number;
  sampleRate: number;
  base: StemBase;
}

export class StemPacker {
  private L: Int16Array;
  private R: Int16Array;
  private n = 0; // samples consumed (and written)
  private readonly limit: number; // hard cap on samples written; Infinity = grow as needed
  private readonly aLow: number;
  private readonly aMid: number;
  private lp200 = 0;
  private lp2000 = 0;
  private lSum = 0;
  private mSum = 0;
  private hSum = 0;
  private maxLow = 1e-9;
  private maxMid = 1e-9;
  private maxHigh = 1e-9;
  private bMin = 1;
  private bMax = -1;
  private cnt = 0;
  private bi = 0;
  private min: Float32Array;
  private max: Float32Array;
  private low: Float32Array;
  private mid: Float32Array;
  private high: Float32Array;

  /** `capacity` = how many samples to allocate up front (an exact length, or an estimate when the
   *  stream length is not known yet — it grows if exceeded). `limit` = never write past this many
   *  samples, and pad the output to exactly this length (the other stems of a set must match the
   *  first one's length, as the old pack did). */
  constructor(readonly sampleRate: number, capacity: number, limit = Infinity) {
    this.limit = limit;
    const cap = Math.max(1, Number.isFinite(limit) ? limit : capacity);
    this.L = new Int16Array(cap);
    this.R = new Int16Array(cap);
    const buckets = Math.max(1, Math.ceil(cap / PACK_BUCKET));
    this.min = new Float32Array(buckets);
    this.max = new Float32Array(buckets);
    this.low = new Float32Array(buckets);
    this.mid = new Float32Array(buckets);
    this.high = new Float32Array(buckets);
    this.aLow = 1 - Math.exp((-2 * Math.PI * 200) / sampleRate);
    this.aMid = 1 - Math.exp((-2 * Math.PI * 2000) / sampleRate);
  }

  private grow(need: number) {
    const cap = Math.max(need, Math.ceil(this.L.length * 1.25));
    const L = new Int16Array(cap);
    L.set(this.L);
    this.L = L;
    const R = new Int16Array(cap);
    R.set(this.R);
    this.R = R;
    const buckets = Math.ceil(cap / PACK_BUCKET);
    const g = (a: Float32Array) => {
      const b = new Float32Array(buckets);
      b.set(a);
      return b;
    };
    this.min = g(this.min);
    this.max = g(this.max);
    this.low = g(this.low);
    this.mid = g(this.mid);
    this.high = g(this.high);
  }

  private flush() {
    const c = this.cnt;
    const lv = Math.sqrt(this.lSum / c);
    const mv = Math.sqrt(this.mSum / c);
    const hv = Math.sqrt(this.hSum / c);
    const bi = this.bi;
    this.min[bi] = this.bMin;
    this.max[bi] = this.bMax;
    this.low[bi] = lv;
    this.mid[bi] = mv;
    this.high[bi] = hv;
    if (lv > this.maxLow) this.maxLow = lv;
    if (mv > this.maxMid) this.maxMid = mv;
    if (hv > this.maxHigh) this.maxHigh = hv;
    this.bi++;
    this.bMin = 1;
    this.bMax = -1;
    this.lSum = this.mSum = this.hSum = 0;
    this.cnt = 0;
  }

  /** Pack `count` samples of left/right float PCM (pass the same array twice for mono). */
  push(fL: Float32Array, fR: Float32Array, count = fL.length): void {
    const room = this.limit - this.n;
    const take = Math.min(count, room);
    if (take <= 0) return;
    if (this.n + take > this.L.length) this.grow(this.n + take);
    const oL = this.L;
    const oR = this.R;
    const aLow = this.aLow;
    const aMid = this.aMid;
    let lp200 = this.lp200;
    let lp2000 = this.lp2000;
    let bMin = this.bMin;
    let bMax = this.bMax;
    let lSum = this.lSum;
    let mSum = this.mSum;
    let hSum = this.hSum;
    let cnt = this.cnt;
    let o = this.n;
    for (let i = 0; i < take; i++, o++) {
      const l = fL[i];
      const r = fR[i];
      const sl = l * 32767;
      const srr = r * 32767;
      oL[o] = sl < -32767 ? -32767 : sl > 32767 ? 32767 : Math.round(sl);
      oR[o] = srr < -32767 ? -32767 : srr > 32767 ? 32767 : Math.round(srr);
      const mm = (l + r) * 0.5;
      lp200 += aLow * (mm - lp200);
      lp2000 += aMid * (mm - lp2000);
      const lo = lp200;
      const md = lp2000 - lp200;
      const hi = mm - lp2000;
      if (mm < bMin) bMin = mm;
      if (mm > bMax) bMax = mm;
      lSum += lo * lo;
      mSum += md * md;
      hSum += hi * hi;
      if (++cnt >= PACK_BUCKET) {
        this.bMin = bMin;
        this.bMax = bMax;
        this.lSum = lSum;
        this.mSum = mSum;
        this.hSum = hSum;
        this.cnt = cnt;
        this.flush();
        bMin = 1;
        bMax = -1;
        lSum = mSum = hSum = 0;
        cnt = 0;
      }
    }
    this.lp200 = lp200;
    this.lp2000 = lp2000;
    this.bMin = bMin;
    this.bMax = bMax;
    this.lSum = lSum;
    this.mSum = mSum;
    this.hSum = hSum;
    this.cnt = cnt;
    this.n = o;
  }

  /** Close the stream. Output length = `limit` when one was given (silence-padded), else exactly the
   *  samples pushed. The int16 arrays are views over buffers that may carry a little unused slack
   *  when the capacity estimate was high — harmless, and cheaper than a copy to trim it. */
  finish(): PackedStem {
    if (this.cnt > 0) this.flush();
    const len = Number.isFinite(this.limit) ? this.limit : this.n;
    const buckets = Math.max(1, Math.ceil(len / PACK_BUCKET));
    if (buckets > this.min.length) this.grow(len);
    const { maxLow, maxMid, maxHigh } = this;
    const cut = (a: Float32Array) => (a.length === buckets ? a : a.slice(0, buckets));
    const low = cut(this.low);
    const mid = cut(this.mid);
    const high = cut(this.high);
    for (let i = 0; i < buckets; i++) {
      low[i] /= maxLow;
      mid[i] /= maxMid;
      high[i] /= maxHigh;
    }
    const view = (a: Int16Array) => (a.length === len ? a : a.subarray(0, len));
    return {
      L: view(this.L),
      R: view(this.R),
      length: len,
      sampleRate: this.sampleRate,
      base: { min: cut(this.min), max: cut(this.max), low, mid, high, bucket: PACK_BUCKET },
    };
  }
}

/** Samples an Opus packet decodes to at 48 kHz, read from its TOC byte (RFC 6716 §3.1). Used to size
 *  a stem's int16 output BEFORE decoding, so the decoder's frames can be packed as they arrive with
 *  no full-length float32 staging and no grow-and-copy. 0 for a malformed packet. */
export function opusPacketSamples48k(pkt: Uint8Array): number {
  if (pkt.length < 1) return 0;
  const toc = pkt[0];
  const config = toc >> 3;
  // Frame duration in 48 kHz samples: SILK 10/20/40/60 ms, Hybrid 10/20 ms, CELT 2.5/5/10/20 ms.
  let fs: number;
  if (config < 12) fs = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) fs = [480, 960][config & 1];
  else fs = [120, 240, 480, 960][config & 3];
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 3) frames = pkt.length >= 2 ? pkt[1] & 0x3f : 0;
  else frames = 2;
  return fs * frames;
}
