import { describe, expect, it } from "vitest";
import { isHashedAsset } from "./index";

// `immutable` is a ONE-WAY promise: a browser that caches a response under it will not
// re-ask for a year, and there is no way to recall it. So the only thing standing between a
// correct deploy and a permanently-pinned stale file is this predicate. The negative cases
// below matter more than the positive ones.
describe("isHashedAsset", () => {
  it("accepts Vite's build-hashed output", () => {
    expect(isHashedAsset("/assets/index-C_HhFLhk.js")).toBe(true);
    expect(isHashedAsset("/assets/index-DkK9m2Qf.css")).toBe(true);
    expect(isHashedAsset("/assets/some.worker-A1b2C3d4.js")).toBe(true);
  });

  it("REFUSES the unhashed public/ payloads — the ones that would pin forever", () => {
    // These keep their real filenames across deploys. Marked immutable, a stale model would
    // sit in every browser that ever touched it with no name change to dislodge it.
    expect(isHashedAsset("/models/htdemucs.onnx")).toBe(false);
    expect(isHashedAsset("/ort/ort-wasm-simd-threaded.wasm")).toBe(false);
    expect(isHashedAsset("/favicon.svg")).toBe(false);
    expect(isHashedAsset("/manifest.webmanifest")).toBe(false);
  });

  it("REFUSES the document — caching it would kill the update mechanism", () => {
    // index.html is the only thing naming the hashed assets. If it can be cached, a reload
    // does not necessarily reach the new build, which is the entire guarantee.
    expect(isHashedAsset("/")).toBe(false);
    expect(isHashedAsset("/index.html")).toBe(false);
    expect(isHashedAsset("/@handle")).toBe(false);
    expect(isHashedAsset("/set/abc123")).toBe(false);
  });

  it("REFUSES an /assets/ path with no hash in the name", () => {
    expect(isHashedAsset("/assets/logo.svg")).toBe(false);
    expect(isHashedAsset("/assets/short-abc.js")).toBe(false); // suffix too short to be a hash
  });

  it("REFUSES api routes and anything nested below /assets/", () => {
    expect(isHashedAsset("/api/health")).toBe(false);
    expect(isHashedAsset("/assets/nested/index-C_HhFLhk.js")).toBe(false);
  });
});
