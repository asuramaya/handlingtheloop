/* tslint:disable */
/* eslint-disable */

/**
 * Result of running source separation. Owns a flat interleaved buffer:
 * `[stem0_L | stem0_R | stem1_L | stem1_R | ...]`
 */
export class SeparationResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns stem names as a JS array of strings.
     */
    stem_names(): any;
    /**
     * Move the audio buffer to JS, consuming this result.
     */
    take_audio(): Float32Array;
    readonly n_samples: number;
    readonly num_stems: number;
}

/**
 * Result of computing a spectrogram from audio samples.
 *
 * Holds dB magnitudes in a flat `[frame × bin]` layout with a
 * log-frequency-friendly linear bin axis (0 … n_fft/2).
 */
export class SpectrogramResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Return the raw dB-magnitude buffer, consuming this result.
     *
     * wasm-bindgen converts the `Vec<f32>` to a JS `Float32Array`
     * without an extra copy because ownership is moved.
     */
    take_mags(): Float32Array;
    readonly num_bins: number;
    readonly num_frames: number;
}

/**
 * Compute the STFT of a mono audio signal and return dB magnitudes.
 *
 * Accepts a `Float32Array` of samples (typically from `AudioBuffer.getChannelData`).
 * Uses `n_fft = 4096` and `hop_length = 1024` to match HTDemucs.
 */
export function compute_spectrogram(samples: Float32Array): SpectrogramResult;

/**
 * Serialize the autotune winners gathered so far (call AFTER a separation) so the
 * host can persist them. Returns `{}` if nothing was tuned.
 */
export function export_autotune(): string;

/**
 * Returns the model registry as a JS array of model info objects.
 *
 * Each object has: id, label, description, size_mb, stems, filename, download_url
 */
export function get_model_registry(): any;

/**
 * Load a previously-saved autotune cache (JSON from IndexedDB / crowd pool) BEFORE
 * the first separation, so every tuner restores its winners and skips benchmarking.
 */
export function import_autotune(json: string): void;

/**
 * Run source separation on stereo audio.
 *
 * - `model_bytes`: safetensors weights from IndexedDB
 * - `model_id`: e.g. "htdemucs", "htdemucs_6s", "htdemucs_ft"
 * - `selected_stems`: JS string array of stem names to extract
 * - `left`, `right`: stereo PCM samples
 * - `sample_rate`: sample rate of the input audio (resampled internally if != 44100)
 * - `on_progress`: optional JS callback `(event: object) => void` for progress updates
 *
 * Returns a `SeparationResult` with flat buffer: per stem, L then R channel.
 */
export function separate(model_bytes: Uint8Array, model_id: string, selected_stems: any, left: Float32Array, right: Float32Array, sample_rate: number, on_progress?: Function | null): Promise<SeparationResult>;

/**
 * Validate safetensors model weights.
 *
 * Parses the safetensors header (fast — doesn't read tensor data) and checks
 * that all expected signature prefixes are present. Returns a JS object:
 * `{ valid: true, tensor_counts: [533] }` or `{ valid: false, error: "..." }`
 */
export function validate_model_weights(bytes: Uint8Array, model_id: string): any;

/**
 * Initialize WebGPU, load the model, and run a dummy forward pass to
 * pre-compile all GPU shaders. Call once before real inference to avoid
 * shader compilation stalls.
 *
 * Returns after the warmup forward pass completes.
 */
export function warmup_model(model_bytes: Uint8Array, model_id: string): Promise<void>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_separationresult_free: (a: number, b: number) => void;
    readonly __wbg_spectrogramresult_free: (a: number, b: number) => void;
    readonly compute_spectrogram: (a: number, b: number) => [number, number, number];
    readonly export_autotune: () => [number, number];
    readonly get_model_registry: () => [number, number, number];
    readonly import_autotune: (a: number, b: number) => void;
    readonly separate: (a: number, b: number, c: number, d: number, e: any, f: number, g: number, h: number, i: number, j: number, k: number) => any;
    readonly separationresult_n_samples: (a: number) => number;
    readonly separationresult_num_stems: (a: number) => number;
    readonly separationresult_stem_names: (a: number) => [number, number, number];
    readonly separationresult_take_audio: (a: number) => [number, number];
    readonly spectrogramresult_num_bins: (a: number) => number;
    readonly spectrogramresult_num_frames: (a: number) => number;
    readonly spectrogramresult_take_mags: (a: number) => [number, number];
    readonly validate_model_weights: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly warmup_model: (a: number, b: number, c: number, d: number) => any;
    readonly wasm_bindgen__closure__destroy__h6d67645722ce49f9: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h2ca29e8fdc17bd6f: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h88cf6c5a25f62fc1: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
