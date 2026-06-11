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
  void saveStemsLocal(videoId, modelId, blobs); // local: survives refresh
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
// Resolve the four stems for a track under the SELECTED model:
//   • dsp model → the instant on-device DSP split (no download).
//   • onnx model → cache-first: pull this model's stems from R2 if warm; else, on
//     a capable device, separate in-browser and share the result back to R2; on a
//     weak device with a cold cache, fall back to the DSP split so buttons still work.
// All paths return the same `Stems` shape, so the deck/UI never changes.
export async function loadStems(
  ctx: BaseAudioContext,
  videoId: string,
  mix: AudioBuffer,
  model: StemModel | string = "dsp",
  onProgress?: (pct: number) => void,
  force = false, // re-analyze: skip the cache (R2 download) and RE-COMPUTE, overwriting it
): Promise<Stems> {
  const m = typeof model === "string" ? getStemModel(model) : model;
  if (m.kind === "dsp") return dspStems(mix);

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
  // fall back to the instant DSP split so the stem buttons still work.
  if (!deviceSupportsModel(m)) return dspStems(mix);

  // route to the engine for this model's architecture (both run in workers).
  // Stems are second-class: ANY failure (model weights 404 on the edge, worker
  // crash, OOM) must NEVER bubble up and break the deck — fall back to the
  // instant DSP split so the stem buttons always work.
  try {
    const separate = m.arch === "demucs" ? separateDemucs : separateOpenUnmix;
    const stems = await separate(mix, m, onProgress);
    void persistStems(videoId, m.id, stems); // cache locally (refresh) + share to R2
    return stems;
  } catch {
    return dspStems(mix);
  }
}

// --- no-model DSP stem split --------------------------------------------------
// A sum-exact decomposition of the mix: bass = lows, drums = highs, vocals =
// the centre channel's vocal band, other = the residual (original − the rest).
// Because `other` is the residual, every stem ON reconstructs the original mix
// bit-for-bit, and muting any stem cleanly subtracts it. Not as clean as Demucs,
// but real, instant, and on the same client-side-only path (runs in an
// OfflineAudioContext — no Worker compute, by design).
export async function dspStems(buffer: AudioBuffer): Promise<Stems> {
  const bass = await renderFiltered(buffer, buffer, (ctx, src) => {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 200;
    f.Q.value = 0.7;
    src.connect(f);
    return f;
  });
  const drums = await renderFiltered(buffer, buffer, (ctx, src) => {
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 5000;
    src.connect(f);
    return f;
  });
  // Vocals: the centre channel (L+R)/2, band-passed to the vocal range, then
  // up-mixed back to stereo so muting it pulls voice out of both channels.
  const voiceMono = await renderFiltered(buffer, midBuffer(buffer), (ctx, src) => {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3500;
    src.connect(hp);
    hp.connect(lp);
    return lp;
  });
  const vocals = upmix(voiceMono, buffer.numberOfChannels, buffer.sampleRate);
  const other = await residual(buffer, [bass, drums, vocals]);
  return { vocals, drums, bass, other };
}

function renderFiltered(
  ref: AudioBuffer,
  srcBuffer: AudioBuffer,
  build: (ctx: OfflineAudioContext, src: AudioBufferSourceNode) => AudioNode,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(srcBuffer.numberOfChannels, ref.length, ref.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = srcBuffer;
  build(ctx, src).connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

function midBuffer(buffer: AudioBuffer): AudioBuffer {
  const { length, sampleRate, numberOfChannels } = buffer;
  const L = buffer.getChannelData(0);
  const R = numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const mid = new AudioBuffer({ length, sampleRate, numberOfChannels: 1 });
  const m = mid.getChannelData(0);
  for (let i = 0; i < length; i++) m[i] = (L[i] + R[i]) * 0.5;
  return mid;
}

function upmix(mono: AudioBuffer, channels: number, sampleRate: number): AudioBuffer {
  if (channels <= 1) return mono;
  const out = new AudioBuffer({ length: mono.length, sampleRate, numberOfChannels: channels });
  const m = mono.getChannelData(0);
  for (let c = 0; c < channels; c++) out.getChannelData(c).set(m);
  return out;
}

// other = original − Σ parts, so the four stems always sum back to the mix.
// Yield control back to the browser (a macrotask, so it can paint / handle input
// between chunks of heavy sample work — a microtask wouldn't unblock rendering).
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// `other` = original − (bass + drums + vocals), per sample. For a multi-minute
// track this is tens of millions of subtractions, so it runs in ~1M-sample
// chunks that yield between them — the UI stays responsive instead of freezing.
async function residual(orig: AudioBuffer, parts: AudioBuffer[]): Promise<AudioBuffer> {
  const { length, sampleRate, numberOfChannels } = orig;
  const out = new AudioBuffer({ length, sampleRate, numberOfChannels });
  const CHUNK = 1 << 20;
  for (let c = 0; c < numberOfChannels; c++) {
    const o = out.getChannelData(c);
    o.set(orig.getChannelData(c));
    const pcs = parts.map((p) => (c < p.numberOfChannels ? p.getChannelData(c) : p.getChannelData(0)));
    for (let start = 0; start < length; start += CHUNK) {
      const end = Math.min(length, start + CHUNK);
      for (let i = start; i < end; i++) {
        for (let k = 0; k < pcs.length; k++) o[i] -= pcs[k][i];
      }
      await yieldToMain();
    }
  }
  return out;
}
