// The Whisper models offered for on-device lyric transcription from the isolated vocal
// stem. Loaded by transcribe.worker.ts through transformers.js (WebGPU on Chromium, wasm
// elsewhere — the same bundle split the stems separator uses). Two tiers, mirroring the
// stem-quality picker: base is fast and fine on clear / spoken vocals; small is markedly
// better on SUNG lyrics (Whisper is trained on speech, so singing is the hard case) at a
// few× the GPU time + a bigger download.
export type LyricsModel = "base" | "small";

export interface WhisperModelInfo {
  id: LyricsModel;
  repo: string; // transformers.js model id on the HF hub
  label: string;
  params: string;
  blurb: string;
}

// NB: the `_timestamped` variants embed Whisper's cross-attention alignment heads, which
// transformers.js needs for WORD-level timestamps (`return_timestamps:"word"`). The plain
// repos only do segment-level, so we'd never get per-word markers.
export const WHISPER_MODELS: WhisperModelInfo[] = [
  {
    id: "base",
    repo: "onnx-community/whisper-base_timestamped",
    label: "Base",
    params: "74M",
    blurb: "Fast. Solid on clear or spoken vocals; lighter first-run download (~80 MB).",
  },
  {
    id: "small",
    repo: "onnx-community/whisper-small_timestamped",
    label: "Small",
    params: "244M",
    blurb: "~3× slower but noticeably better on sung lyrics (~240 MB download).",
  },
];

export function whisperModel(id: string): WhisperModelInfo {
  return WHISPER_MODELS.find((m) => m.id === id) ?? WHISPER_MODELS[0];
}
