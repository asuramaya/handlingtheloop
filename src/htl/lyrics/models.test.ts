import { describe, it, expect } from "vitest";
import { WHISPER_MODELS, whisperModel, isWhisperModel } from "./models";

// These guard the two ways this file has actually lied to users.
describe("the lyrics model lineup", () => {
  it("★ every model's advertised size is the size of the files its OWN dtype downloads", () => {
    // The size and the precision are one fact, and they drifted apart for the whole life of the
    // feature: the UI said "~80 MB" / "~240 MB" while the shipped fp32-encoder + q4-decoder build
    // pulled 206 MB and 586 MB. The numbers below are the measured ONNX file sizes (HF API), so
    // this test fails the moment someone changes a dtype without re-checking what it costs.
    const ENCODER_MB: Record<string, Record<string, number>> = {
      "onnx-community/whisper-small_timestamped": { fp32: 352.8, q4: 66.2 },
      "onnx-community/whisper-large-v3-turbo_timestamped": { fp32: 2548.4, q4: 425.0 },
    };
    const DECODER_MB: Record<string, Record<string, number>> = {
      "onnx-community/whisper-small_timestamped": { fp32: 615.7, q4: 233.4 },
      "onnx-community/whisper-large-v3-turbo_timestamped": { fp32: 688.1, q4: 334.2 },
    };
    for (const m of WHISPER_MODELS) {
      const enc = ENCODER_MB[m.repo]?.[m.dtype.encoder_model];
      const dec = DECODER_MB[m.repo]?.[m.dtype.decoder_model_merged];
      expect(enc, `no measured size for ${m.repo} encoder @ ${m.dtype.encoder_model}`).toBeDefined();
      expect(dec, `no measured size for ${m.repo} decoder @ ${m.dtype.decoder_model_merged}`).toBeDefined();
      // Within 1% of the true download — a label, not a rounding argument.
      expect(Math.abs(m.sizeMB - (enc! + dec!)) / m.sizeMB).toBeLessThan(0.01);
    }
  });

  it("★ never fp16 — ORT-web's fp16 WebGPU path miscompiles on Linux+NVIDIA (the demucs saga)", () => {
    for (const m of WHISPER_MODELS) {
      for (const p of Object.values(m.dtype)) expect(p).not.toMatch(/fp16/);
    }
  });

  it("★ Turbo's encoder must NOT be fp32 — that one file is 2.5 GB and makes the model unshippable", () => {
    // This is the trap that kept the best model off the menu: the encoder precision was a constant
    // in the worker, pinned to fp32 "for accuracy", which is right for Small and catastrophic here.
    const turbo = WHISPER_MODELS.find((m) => m.id === "turbo")!;
    expect(turbo.dtype.encoder_model).toBe("q4");
    expect(turbo.sizeMB).toBeLessThan(1000);
  });

  it("resolves a RETIRED id rather than blanking — an existing user is set to \"base\"", () => {
    // `base` was dropped (multilingual, but poor at singing, which is this app's only case). Anyone
    // who had selected it still has that string in their saved settings.
    expect(whisperModel("base").id).toBe("small");
    expect(whisperModel("").id).toBe("small");
    expect(isWhisperModel("base")).toBe(false);
    expect(isWhisperModel("youtube")).toBe(false);
    expect(isWhisperModel("turbo")).toBe(true);
  });

  it("exactly one model is flagged best", () => {
    expect(WHISPER_MODELS.filter((m) => m.best)).toHaveLength(1);
  });
});
