import { describe, it, expect } from "vitest";
import { pickRecorderMime, LOSSLESS_RECORD_MIMES } from "./recorderFormat";

describe("pickRecorderMime", () => {
  it("takes the browser default when nothing lossless is offered (Safari/iOS: mp4/AAC only)", () => {
    expect(pickRecorderMime((t) => t === "audio/mp4")).toBeUndefined();
  });

  it("prefers webm/pcm when it is on offer", () => {
    expect(pickRecorderMime(() => true)).toBe("audio/webm;codecs=pcm");
  });

  it("falls through the list rather than giving up at the first miss", () => {
    expect(pickRecorderMime((t) => t === "audio/ogg;codecs=flac")).toBe("audio/ogg;codecs=flac");
  });

  it("treats a thrown answer as a no, not as a crash", () => {
    expect(
      pickRecorderMime((t) => {
        if (t === "audio/webm;codecs=pcm") throw new TypeError("unknown type");
        return t === "audio/wav";
      }),
    ).toBe("audio/wav");
  });

  it("takes the default when the browser has no isTypeSupported at all", () => {
    expect(pickRecorderMime(undefined)).toBeUndefined();
  });

  // The control: a picker that returned something for EVERY environment would hide the fallback,
  // and the fallback is the half that still owes a clamp warning.
  it("every candidate it can return is lossless — no codec sneaks onto the list", () => {
    for (const m of LOSSLESS_RECORD_MIMES) {
      expect(m).toMatch(/pcm|wav|flac/);
      expect(pickRecorderMime((t) => t === m)).toBe(m);
    }
  });
});
