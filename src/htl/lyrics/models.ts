// The Whisper models offered for on-device lyric transcription from the isolated vocal
// stem. Loaded by transcribe.worker.ts through transformers.js (WebGPU on Chromium, wasm
// elsewhere — the same bundle split the stems separator uses).
//
// ★ MODEL CHOICE IS NOW A TRANSCRIPTION-QUALITY QUESTION ONLY. It used to also be a TIMING
// question, because we took Whisper's word timestamps at face value — and those are inferred
// from cross-attention, which is exactly what collapses on singing. Since align.ts, the TIMES
// come from the vocal stem's real onsets and Whisper only supplies the WORDS. So pick the model
// that hears lyrics best and stop worrying about its clock.
//
// ★ AND THE SIZES ARE REAL. Every number below is the sum of the ONNX files we ACTUALLY
// request for that model (see `dtype`), measured against the HF API — not a guess, and not
// the parameter count in disguise. The old labels claimed "~80 MB" and "~240 MB" for base and
// small; the true downloads were 206 MB and 586 MB. Nobody had ever checked.
export type LyricsModel = "small" | "turbo";

export interface WhisperModelInfo {
  id: LyricsModel;
  repo: string; // transformers.js model id on the HF hub
  label: string;
  params: string;
  /** First-run download, MB — encoder + decoder at the `dtype` below. Measured, not estimated. */
  sizeMB: number;
  /** Per-submodel precision. THIS is what decides sizeMB, so the two live together or they drift
   *  apart again. q4 is integer MatMulNBits — NOT the fp16 shader path that ORT-web's WebGPU EP
   *  miscompiles on Linux+NVIDIA (the demucs fp16 saga). Never put fp16 here. */
  dtype: Record<string, string>;
  note: string;
  /** The one to pick if you don't care to think about it. */
  best?: boolean;
}

// NB: the `_timestamped` variants embed Whisper's cross-attention alignment heads, which
// transformers.js needs for word-level chunks (`return_timestamps:"word"`). We no longer trust
// those timestamps, but we still use them to SEED the aligner, and the plain repos return no word
// chunks at all — so keep them.
export const WHISPER_MODELS: WhisperModelInfo[] = [
  {
    id: "small",
    repo: "onnx-community/whisper-small_timestamped",
    label: "Small",
    params: "244M",
    // encoder_model.onnx 352.8 + decoder_model_merged_q4.onnx 233.4
    sizeMB: 586,
    dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
    note: "Multilingual, quick, and light on VRAM. Fine on clear vocals; misses words in dense or heavily-produced mixes.",
  },
  {
    id: "turbo",
    repo: "onnx-community/whisper-large-v3-turbo_timestamped",
    label: "Large v3 Turbo",
    params: "809M",
    // encoder_model_q4.onnx 425.0 + decoder_model_merged_q4.onnx 334.2
    sizeMB: 759,
    // The ONLY model here whose ENCODER is quantised — and it has to be. Turbo is large-v3 with
    // a 4-layer decoder, so it inherits large's full-size encoder: at fp32 that file alone is
    // 2.5 GB. At q4 it's 425 MB, which is what makes this model shippable in a browser at all.
    dtype: { encoder_model: "q4", decoder_model_merged: "q4" },
    note: "The best lyrics we can run in a browser. Far stronger on sung and non-English vocals — 3× the model for ~170 MB more than Small.",
    best: true,
  },
];

/** The model to resolve to, tolerating ids we no longer ship (`base`, retired: multilingual, but
 *  genuinely poor at singing — which is the only case this app has). */
export function whisperModel(id: string): WhisperModelInfo {
  return WHISPER_MODELS.find((m) => m.id === id) ?? WHISPER_MODELS[0];
}

/** Is `id` one of the Whisper engines (vs "youtube", or a retired id)? */
export function isWhisperModel(id: string): boolean {
  return WHISPER_MODELS.some((m) => m.id === id);
}
