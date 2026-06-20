export type DeckId = "A" | "B"; // which deck a control targets — the shared audio primitive
export { AudioEngine } from "./AudioEngine";
export { Deck, HOT_CUE_COUNT, type Loop, type StemView } from "./Deck";
export { Eq3, EQ_MIN_DB, EQ_MAX_DB, EQ_BANDS, EQ_HP, EQ_LP, EQ_Q_MIN, EQ_Q_MAX, EQ_SHAPE_TYPES, EQ_SHAPE_LABELS, EQ_SHAPE_DEFAULT, type EqRoute } from "./Eq3";
export { FxRack, BaseFxDevice, type FxDevice, type FxKind, type FxParam } from "./Fx";
export { DelayFx, DELAY_MAX_SECONDS } from "./DelayFx";
export { ReverbFx, REVERB_STYLES } from "./ReverbFx";
export { SaturatorFx, SAT_STYLES, type SatStyle } from "./SaturatorFx";
export { CrushFx, CRUSH_MODES, type CrushMode } from "./CrushFx";
export { REVERB_WORKLET_SRC } from "./reverbWorklet";
export { CRUSH_WORKLET_SRC } from "./crushWorklet";
export { loadFxPresets, saveFxPreset, renameFxPreset, deleteFxPreset, type FxPreset } from "./fxPresets";
export { decodeAudio } from "./decode";
export { Sampler, type SampleMode, type SampleRoute, type PlayOpts } from "./Sampler";
export { getCachedTrack, setCachedTrack, getCachedMeta, dropCachedBuffer, type CachedTrack } from "./trackCache";
export { STRETCH_WORKLET_SRC } from "./stretchWorklet";
