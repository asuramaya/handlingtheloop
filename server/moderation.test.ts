// Moderation gate: the verdict parsing + the all-important FAIL-OPEN behaviour (a model error or
// an unbound AI must never block a write).
import { describe, expect, it } from "vitest";
import { imageIsUnsafe, textIsUnsafe } from "./moderation";

const fakeAi = (impl: (model: string) => unknown) => ({ run: async (model: string) => impl(model) });

describe("imageIsUnsafe", () => {
  const px = new Uint8Array([1, 2, 3]);
  it("blocks on a YES verdict, allows on NO", async () => {
    expect(await imageIsUnsafe(fakeAi(() => ({ description: "YES" })), px)).toBe(true);
    expect(await imageIsUnsafe(fakeAi(() => ({ description: "No, it's a logo." })), px)).toBe(false);
  });
  it("fails OPEN when AI is unbound or throws", async () => {
    expect(await imageIsUnsafe(undefined, px)).toBe(false);
    expect(await imageIsUnsafe(fakeAi(() => { throw new Error("AI down"); }), px)).toBe(false);
  });
});

describe("textIsUnsafe", () => {
  it("blocks a leading 'unsafe', allows 'safe'", async () => {
    expect(await textIsUnsafe(fakeAi(() => ({ response: "unsafe\nS1,S10" })), "some flagged bio text")).toBe(true);
    expect(await textIsUnsafe(fakeAi(() => ({ response: "safe" })), "hi there")).toBe(false);
  });
  it("skips empties and fails OPEN on error/unbound", async () => {
    expect(await textIsUnsafe(fakeAi(() => ({ response: "unsafe" })), " ")).toBe(false); // too short
    expect(await textIsUnsafe(undefined, "anything")).toBe(false);
    expect(await textIsUnsafe(fakeAi(() => { throw new Error("x"); }), "anything")).toBe(false);
  });
});
