export type DeckId = "A" | "B"; // which deck a control targets — the shared audio primitive
export { AudioEngine } from "./AudioEngine";
export { Deck, HOT_CUE_COUNT, PAD_MODE_SHIFT, PAD_MODE_RESERVED, type Loop, type StemView, type PadMode } from "./Deck";
export { Eq3, EQ_MIN_DB, EQ_MAX_DB, EQ_OUT_DB, EQ_BANDS, EQ_HP, EQ_LP, EQ_Q_MIN, EQ_Q_MAX, EQ_SHAPE_TYPES, EQ_SHAPE_LABELS, EQ_SHAPE_DEFAULT, type EqRoute } from "./Eq3";
export { FxRack, BaseFxDevice, ALL_STEMS, type FxDevice, type FxKind, type FxParam, type FxChain, type FxAddr } from "./Fx";
export { qToResDb, qToFrac, fracToQ, FLAT_RES_DB, RES_SPAN_DB } from "./fxDsp";
export { snapIndex } from "./snap";
export { DelayFx, DELAY_MAX_SECONDS } from "./DelayFx";
export { ReverbFx, REVERB_STYLES } from "./ReverbFx";
export { SaturatorFx, SAT_STYLES, type SatStyle } from "./SaturatorFx";
export { CrushFx, CRUSH_MODES, type CrushMode } from "./CrushFx";
export { ModFx, MOD_MODES, MOD_WAVES, MOD_SOURCES, BARBER_RAMPS, modLfoShape, barberRampShape } from "./ModFx";
export { GateFx, GATE_SHAPES, type GateShape } from "./GateFx";
export { NoiseFx, NOISE_TYPES, NOISE_DIRS, noiseEase, noiseBuildEnd, type NoiseType } from "./NoiseFx";
export { CompFx, COMP_MODES, COMP_SC_SOURCES, makeMasterLimiter, type CompMode } from "./CompFx";
export { REVERB_WORKLET_SRC } from "./reverbWorklet";
export { CRUSH_WORKLET_SRC } from "./crushWorklet";
export { MOD_DELAY_WORKLET_SRC } from "./modDelayWorklet";
export { loadFxPresets, saveFxPreset, renameFxPreset, deleteFxPreset, factoryFxPresets, FACTORY_PRESETS, type FxPreset } from "./fxPresets";
export { loadFxRows, saveFxRows, loadFxBank, saveFxBank, resolveFxRows, presetOf, entryOf, foldRows, reorderTop, reorderInGroup, fileIntoGroup, moveOutOfGroup, moveBetweenGroups, addFxSection, renameFxSection, deleteFxSection, materialiseFxRow, revertFxRow, deleteFxRow, restoreFxFactory, resetFxArrangement, fxBankStats, factoryFxRows, onFxBankChange, hydrateFxBanks, isGroup, isSep, isRef, leafName, rowName, NEW_SECTION, type FxRow, type FxSep, type FxRef, type FxLeaf, type FxGroup, type FxPath, type FxBank, type FxEntry } from "./fxPresets";
export { loadChainPresets, saveChainPreset, deleteChainPreset, renameChainPreset, factoryChainPresets, chainRows as bankChainRows, chainOf, CHAIN_KIND, type ChainPreset } from "./fxPresets";
export { decodeAudio } from "./decode";
export { MicInput, type MicRoute } from "./MicInput";
export { Recorder, type Take } from "./Recorder";
export {
  Sampler,
  SAMPLER_GLOBAL_COUNT,
  SAMPLER_REGION_COUNT,
  SAMPLER_PAD_COUNT,
  samplerRouteOf,
  type SampleMode,
  type SampleRoute,
  type PlayOpts,
} from "./Sampler";
export { getCachedTrack, setCachedTrack, getCachedMeta, dropCachedBuffer, type CachedTrack } from "./trackCache";
export { STRETCH_WORKLET_SRC } from "./stretchWorklet";
