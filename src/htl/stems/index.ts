// Stem separation, mobile-first. The model is NEVER bundled and NEVER runs on a
// weak device: the flow is cache-first.
//
//   1. ask the Worker which stems are already in R2 (separated by someone before)
//   2. if all four are there -> just DOWNLOAD + decode them (this is the phone path)
//   3. otherwise, only on a capable device, run the model in-browser (onnxruntime
//      loaded from a CDN on demand), then UPLOAD the stems to R2 so the next
//      person — including phones — gets the cheap download path.
//
// So the heavy compute happens once, on whoever can do it, and is shared via R2.
import { decodeAudio } from "../audio/decode";
import { getStemBlobs, putStemBlobs, hasStemBlobs } from "../persistence";
import { separateOpenUnmix } from "./openunmix";
export { setDemucsQuality } from "./openunmix";
import { separateDemucs } from "./demucs";
import { getStemModel, deviceSupportsModel, type StemModel } from "./models";
import { opusStemsSupported, encodeStemOpus, isOpusStem, decodeStemOpus } from "./opus";

export * from "./models";
export * from "./trace";

// Decode a cached stem blob, whichever format it's in: htl-Opus (small, WebCodecs)
// or WAV (universal fallback). The magic header self-describes, so old WAV caches
// and new Opus caches both round-trip with no manifest coupling.
async function decodeStemBlob(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  if (isOpusStem(bytes)) return decodeStemOpus(ctx, bytes);
  return decodeAudio(ctx, bytes);
}

export const STEM_NAMES = ["vocals", "drums", "bass", "other"] as const;
export type StemName = (typeof STEM_NAMES)[number];
export type Stems = Record<StemName, AudioBuffer>;

export interface StemManifest {
  stems: StemName[];
  complete: boolean;
}

// Every cache call is namespaced by `model` so each backend's stems live apart.
export async function fetchStemManifest(videoId: string, model: string): Promise<StemManifest> {
  try {
    const res = await fetch(`/api/stems?v=${encodeURIComponent(videoId)}&model=${encodeURIComponent(model)}`);
    if (!res.ok) return { stems: [], complete: false };
    return (await res.json()) as StemManifest;
  } catch {
    return { stems: [], complete: false };
  }
}

async function downloadStemBytes(videoId: string, name: StemName, model: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `/api/stems?v=${encodeURIComponent(videoId)}&model=${encodeURIComponent(model)}&s=${name}`,
  );
  if (!res.ok) throw new Error(`stem ${name} ${res.status}`);
  return res.arrayBuffer();
}

// --- local (IndexedDB) stem persistence ---------------------------------------
// Survives a page refresh, so re-hydrating a deck never re-downloads from R2 or
// re-separates — it decodes the four WAVs straight from disk. Keyed per model id.
const localKey = (videoId: string, modelId: string) => `${videoId}:${modelId}`;

export async function loadStemsLocal(ctx: BaseAudioContext, videoId: string, modelId: string): Promise<Stems | null> {
  try {
    const blobs = await getStemBlobs(localKey(videoId, modelId));
    if (!blobs || blobs.length !== STEM_NAMES.length) return null;
    const out = {} as Stems;
    for (let i = 0; i < STEM_NAMES.length; i++) out[STEM_NAMES[i]] = await decodeStemBlob(ctx, blobs[i].slice(0));
    return out;
  } catch {
    return null;
  }
}

// Cheap "are these stems on local disk?" (no decode) — for the Settings cache badge.
export async function hasStemsLocal(videoId: string, modelId: string): Promise<boolean> {
  return hasStemBlobs(localKey(videoId, modelId));
}

async function saveStemsLocal(videoId: string, modelId: string, wav: ArrayBuffer[]): Promise<void> {
  try {
    await putStemBlobs(localKey(videoId, modelId), wav);
  } catch {
    /* fail soft */
  }
}

async function uploadStem(
  videoId: string,
  name: StemName,
  bytes: ArrayBuffer,
  contentType: string,
  model: string,
): Promise<void> {
  try {
    await fetch(`/api/stems?v=${encodeURIComponent(videoId)}&model=${encodeURIComponent(model)}&s=${name}`, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: bytes,
    });
  } catch {
    /* best-effort cache write */
  }
}

// Whether THIS device should attempt on-device separation. Phones and tablets
// NEVER do — they rely on the shared R2 cache, and fall back to the instant DSP
// split on a cold cache. This is deliberate: loading the multi-MB neural runtime
// (ORT wasm / the 11 MB demucs-rs wasm + WebGPU) on iOS Safari or a mobile
// browser OOMs and crashes the tab. iOS 18 now exposes `navigator.gpu`, so we
// must NOT treat "has WebGPU" as "can separate" — that let phones in and crashed
// them. Only reasonably capable desktops separate.
export function canSeparate(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS ≥13 reports a desktop UA, so also catch touch-capable "Mac".
  const iPadOS = navigator.maxTouchPoints > 1 && /Macintosh/.test(ua);
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadOS;
  if (mobile) return false; // phones/tablets: cache or DSP only — never crash
  const cores = navigator.hardwareConcurrency ?? 2;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  return cores >= 4 && mem >= 4;
}

export type StemProgress = (stage: "download" | "separate", pct: number) => void;

// Encode each freshly-separated stem to WAV ONCE, then persist it locally (so a
// refresh re-applies instantly) AND share it to R2 (so the next person — phones
// included — downloads instead of separating).
//
// WAV (not Opus): MediaRecorder encodes in REAL TIME — it plays the buffer back,
// so a 5-minute stem took 5 minutes to encode (≈20 min for all four). The cache
// upload never finished within a session, so it was effectively dead. WAV is
// written instantly from the PCM and decodes natively everywhere (incl. iOS).
async function persistStems(videoId: string, modelId: string, stems: Stems): Promise<void> {
  // Prefer Opus (≈12× smaller in R2, no real-time penalty via WebCodecs); fall back
  // to WAV per-stem if Opus encode isn't available or fails. The blob's magic header
  // self-describes, so the mix of formats decodes transparently on the other end.
  const useOpus = await opusStemsSupported();
  const blobs: ArrayBuffer[] = [];
  for (const name of STEM_NAMES) {
    try {
      blobs.push(useOpus ? await encodeStemOpus(stems[name]) : await encodeWav(stems[name]));
    } catch {
      try {
        blobs.push(await encodeWav(stems[name])); // Opus failed → WAV for this stem
      } catch {
        return; // can't encode at all → skip caching entirely (keep them aligned)
      }
    }
  }
  await saveStemsLocal(videoId, modelId, blobs); // local FIRST (awaited) so a re-derive finds it
  for (let i = 0; i < STEM_NAMES.length; i++) {
    try {
      await uploadStem(videoId, STEM_NAMES[i], blobs[i], "audio/octet-stream", modelId); // R2: shared
    } catch {
      /* skip this stem's cache write */
    }
  }
}

// Write an AudioBuffer to a 16-bit PCM WAV — instant (no real-time playback) and
// decodable by decodeAudioData on every platform. Yields every ~256k frames so a
// multi-minute stem's interleave loop never blocks the main thread.
async function encodeWav(buffer: AudioBuffer): Promise<ArrayBuffer> {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const sr = buffer.sampleRate;
  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));

  const dataBytes = len * numCh * 2;
  const out = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(out);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  dv.setUint32(16, 16, true); // PCM fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * numCh * 2, true); // byte rate
  dv.setUint16(32, numCh * 2, true); // block align
  dv.setUint16(34, 16, true); // bits/sample
  tag(36, "data");
  dv.setUint32(40, dataBytes, true);

  // Interleave into an Int16 view over the data region (little-endian on every
  // platform Web Audio runs on). Direct typed-array writes beat per-sample DataView.
  const pcm = new Int16Array(out, 44, len * numCh);
  let j = 0;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = chans[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      pcm[j++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    if ((i & 0x3ffff) === 0x3ffff) await yieldToMain();
  }
  return out;
}

// --- stem source for the decks ------------------------------------------------
// Resolve the four stems for a track under the SELECTED NEURAL model, cache-first:
// pull this model's stems from R2 if warm; else, on a capable device, separate
// in-browser and share the result back to R2. All paths return the same `Stems`
// shape, so the deck/UI never changes.
//
// NO DSP FALLBACK: when neural separation is unavailable (a device that can't run the
// model with a cold cache) or fails (worker crash / OOM / weights 404), loadStems THROWS
// — it never fabricates a band/centre "DSP split". Every caller catches and plays the
// plain mix with an honest status. A fabricated split was worse than none (it lit the
// stem mixer over pseudo-stems the user couldn't tell from the real thing).
export async function loadStems(
  ctx: BaseAudioContext,
  videoId: string,
  mix: AudioBuffer,
  model: StemModel | string,
  onProgress?: (pct: number) => void,
  force = false, // re-analyze: skip the cache (R2 download) and RE-COMPUTE, overwriting it
): Promise<Stems> {
  const m = typeof model === "string" ? getStemModel(model) : model;
  // A non-neural ("off"/dsp-kind) model has no stems to load — callers gate that upstream
  // (deriveStems treats "off" as the plain no-stems mix), so reaching here is a programmer error.
  if (m.kind === "dsp") throw new Error(`loadStems: non-neural model "${m.id}" has no stems`);

  // neural: R2 cache-first by model id. Download the raw WAV bytes, persist them
  // locally (so the NEXT refresh skips even this download), then decode.
  // `force` skips this — re-analysis wants a fresh compute, not the cached result.
  if (!force)
  try {
    const manifest = await fetchStemManifest(videoId, m.id);
    if (manifest.complete) {
      const out = {} as Stems;
      const wav: ArrayBuffer[] = [];
      for (let i = 0; i < STEM_NAMES.length; i++) {
        const bytes = await downloadStemBytes(videoId, STEM_NAMES[i], m.id);
        wav.push(bytes);
        out[STEM_NAMES[i]] = await decodeStemBlob(ctx, bytes.slice(0));
        onProgress?.((i + 1) / STEM_NAMES.length);
      }
      void saveStemsLocal(videoId, m.id, wav);
      return out;
    }
  } catch {
    /* cache miss → separate or fall back */
  }

  // Cold cache: only separate if THIS device can run THIS model on-device
  // (light int8 → phones too; heavy fp32 → desktop; demucs → desktop GPU). If not,
  // THROW — the caller plays the plain mix (no fabricated DSP split).
  if (!deviceSupportsModel(m)) throw new Error(`loadStems: device can't run "${m.id}" and no cached set`);

  // route to the engine for this model's architecture (both run in workers). ANY failure
  // (model weights 404 on the edge, worker crash, OOM) is logged (so a desktop separation
  // failure is diagnosable) and RE-THROWN — the caller catches it and plays the plain mix.
  // We never fabricate a DSP split to keep the buttons lit.
  try {
    const separate = m.arch === "demucs" ? separateDemucs : separateOpenUnmix;
    const stems = await separate(mix, m, onProgress);
    void persistStems(videoId, m.id, stems); // cache locally (refresh) + share to R2
    return stems;
  } catch (err) {
    console.warn(`[htl] neural separation failed (${m.id}) — playing the mix:`, err);
    throw err;
  }
}

// PRE-PACKED stems: int16 PCM per group (in STEM_NAMES order, so the worklet's stemGain
// indices line up) + the level-0 min/max + low/mid/high envelope per group (for the LOD
// pyramids). The point is to NEVER hold the full float32 stem set — it's the build TRANSIENT
// (~90 MB/min × 4 stems) that OOM-kills a phone on a long track. The engine loads this with
// Deck.loadPackedStems (no float32 intermediate).
export interface PackedStems {
  gL: Int16Array[];
  gR: Int16Array[];
  length: number;
  sampleRate: number;
  base: Record<StemName, { min: Float32Array; max: Float32Array; low: Float32Array; mid: Float32Array; high: Float32Array; bucket: number }>;
}

const PACK_BUCKET = 256; // MUST match STEM_BASE_BUCKET in Deck.ts (the pyramid level-0 bucket)

// CACHE-HIT NEURAL → PRE-PACKED int16, decoding ONE stem at a time. This is the OOM-safe twin of
// the loadStems R2 cache-hit branch (lines ~228-242), which decodes all 4 stems into a full float32
// `Stems` set; on mobile, loading a SECOND long stem track then crash-loops the tab — `Deck.load
// EnginePcm` holds those 4 float32 (~460 MB) while building the 4 int16, briefly doubling the deck's
// footprint into the ~1.5 GB iOS Gigacage. Here each stem is downloaded → decoded → packed to int16
// + envelope → its float32 dropped before the next decode, so only ONE decoded stem is resident at a
// time (peak ≈ 1 float32 + the int16 output, not 4 float32 + 4 int16). The result loads via
// Deck.loadPackedStems with no float32 intermediate. Returns null when the R2 cache isn't complete
// (or anything fails) → the caller falls back to the regular float32 loadStems path.
export async function loadStemsPackedInt16(
  ctx: BaseAudioContext,
  videoId: string,
  model: StemModel | string,
  onProgress?: (pct: number) => void,
): Promise<PackedStems | null> {
  const m = typeof model === "string" ? getStemModel(model) : model;
  if (m.kind === "dsp") return null; // this path is for cached neural sets only
  try {
    const manifest = await fetchStemManifest(videoId, m.id);
    if (!manifest.complete) return null;
    let sr = 0;
    let N = 0;
    let gL: Int16Array[] = [];
    let gR: Int16Array[] = [];
    const base = {} as PackedStems["base"];
    const wav: ArrayBuffer[] = []; // compressed bytes kept for the local cache (parity w/ loadStems)
    for (let gi = 0; gi < STEM_NAMES.length; gi++) {
      const bytes = await downloadStemBytes(videoId, STEM_NAMES[gi], m.id);
      wav.push(bytes); // decode on a COPY so the original survives for saveStemsLocal
      const buf = await decodeStemBlob(ctx, bytes.slice(0));
      if (gi === 0) {
        sr = buf.sampleRate;
        N = buf.length;
        gL = STEM_NAMES.map(() => new Int16Array(N));
        gR = STEM_NAMES.map(() => new Int16Array(N));
      }
      packStemInt16Full(buf, gi, N, sr, gL, gR, base);
      // `buf` (this stem's float32) is now unreferenced; yield so GC reclaims it BEFORE the next
      // decode — the whole point: never hold the full 4-stem float32 set on the phone.
      await yieldToMain();
      onProgress?.((gi + 1) / STEM_NAMES.length);
    }
    void saveStemsLocal(videoId, m.id, wav); // next refresh skips the download (parity w/ loadStems)
    return { gL, gR, length: N, sampleRate: sr, base };
  } catch {
    return null; // any failure → caller uses the regular (float32) loadStems path
  }
}

// Pack one fully-decoded stem AudioBuffer into int16 output group `gi` + its level-0 min/max +
// low/mid/high colour envelope (PACK_BUCKET-aligned, identical math to Deck's fused pack, so the
// LOD pyramids match). Single read of the float32.
function packStemInt16Full(
  buf: AudioBuffer,
  gi: number,
  N: number,
  sr: number,
  gL: Int16Array[],
  gR: Int16Array[],
  base: PackedStems["base"],
): void {
  const fL = buf.getChannelData(0);
  const fR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : fL;
  const n = Math.min(buf.length, N);
  const buckets = Math.ceil(N / PACK_BUCKET);
  const oL = gL[gi];
  const oR = gR[gi];
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const low = new Float32Array(buckets);
  const mid = new Float32Array(buckets);
  const high = new Float32Array(buckets);
  const aLow = 1 - Math.exp((-2 * Math.PI * 200) / sr);
  const aMid = 1 - Math.exp((-2 * Math.PI * 2000) / sr);
  let lp200 = 0;
  let lp2000 = 0;
  let lSum = 0;
  let mSum = 0;
  let hSum = 0;
  let maxLow = 1e-9;
  let maxMid = 1e-9;
  let maxHigh = 1e-9;
  let bMin = 1;
  let bMax = -1;
  let cnt = 0;
  let bi = 0;
  for (let i = 0; i < n; i++) {
    const l = fL[i];
    const r = fR[i];
    const sl = l * 32767;
    const srr = r * 32767;
    oL[i] = sl < -32767 ? -32767 : sl > 32767 ? 32767 : Math.round(sl);
    oR[i] = srr < -32767 ? -32767 : srr > 32767 ? 32767 : Math.round(srr);
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
    if (++cnt >= PACK_BUCKET || i === n - 1) {
      const lv = Math.sqrt(lSum / cnt);
      const mv = Math.sqrt(mSum / cnt);
      const hv = Math.sqrt(hSum / cnt);
      min[bi] = bMin;
      max[bi] = bMax;
      low[bi] = lv;
      mid[bi] = mv;
      high[bi] = hv;
      if (lv > maxLow) maxLow = lv;
      if (mv > maxMid) maxMid = mv;
      if (hv > maxHigh) maxHigh = hv;
      bi++;
      bMin = 1;
      bMax = -1;
      lSum = mSum = hSum = 0;
      cnt = 0;
    }
  }
  for (let i = 0; i < buckets; i++) {
    low[i] /= maxLow;
    mid[i] /= maxMid;
    high[i] /= maxHigh;
  }
  base[STEM_NAMES[gi]] = { min, max, low, mid, high, bucket: PACK_BUCKET };
}

// Yield control back to the browser (a macrotask, so it can paint / handle input
// between chunks of heavy sample work — a microtask wouldn't unblock rendering).
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
