// THE SEPARATION-AUTHORITY GATE — operator ruling: separation is HOST-ONLY, and a listener
// never pays for a set it is merely watching ("we cannot place the debt of separation on mere
// listeners"). This pins the ENFORCEMENT POINT rather than any one caller: every separation
// path in the app — deriveStems, warmStems, the mobile fetch, re-analyze/forceSeparate —
// funnels through loadStems, so guarding there is what makes the rule impossible to forget.
//
// WHAT THIS TEST IS FOR, and why it asserts an EFFECT THAT MUST NOT HAPPEN: the failure it
// guards is silent. A device that separates when it shouldn't still produces correct stems —
// the user hears nothing wrong. Only the second machine's fan tells you, and only during a
// live set. So there is no natural assertion on output; the thing to assert is that the work
// was never STARTED. Hence the spy on the separator, and hence the first case below, which
// fails loudly if the gate is ever removed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const separateNeural = vi.fn();
vi.mock("./separate", () => ({
  separateNeural: (...a: unknown[]) => separateNeural(...a),
  setDemucsQuality: () => {},
}));
// A cold shared cache: the manifest never reports a complete set, so every case here reaches
// the decision the gate governs. (An `ok:false` response is the miss path in fetchStemManifest.)
const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
vi.stubGlobal("fetch", fetchMock);
// Force the DEVICE-CAPABILITY gate open. It sits just downstream of the authority gate and
// answers false in node (no GPU, no navigator), so without this the "allowed" cases below
// throw for an unrelated reason — and a suite where EVERY case throws would show the refusal
// tests green while proving nothing. Isolating to one gate is what makes the green mean
// "authority let it through" rather than "something stopped it".
vi.mock("./models", async (orig) => ({
  ...((await orig()) as object),
  deviceSupportsModel: () => true,
}));

import { loadStems, setSeparationAuthority, NotSeparationAuthority, STEM_NAMES } from "./index";
import { getStemModel } from "./models";

// A desktop-capable neural model, so `deviceSupportsModel` is never the reason we stop —
// otherwise a pass here could be the capability gate, not the authority gate, and the test
// would be green for the wrong reason.
const MODEL = getStemModel("htdemucs");

const fakeCtx = { sampleRate: 44100 } as unknown as BaseAudioContext;
const fakeMix = { length: 44100, sampleRate: 44100, numberOfChannels: 2 } as unknown as AudioBuffer;

describe("separation authority", () => {
  beforeEach(() => {
    separateNeural.mockReset();
    separateNeural.mockResolvedValue(
      Object.fromEntries(STEM_NAMES.map((n) => [n, fakeMix])) as never,
    );
    fetchMock.mockClear();
  });
  afterEach(() => setSeparationAuthority(() => true)); // restore the permissive default

  it("REFUSES to separate when this device is not the authority — and starts no work", async () => {
    setSeparationAuthority(() => false);
    await expect(loadStems(fakeCtx, "vid00000001", fakeMix, MODEL)).rejects.toBeInstanceOf(
      NotSeparationAuthority,
    );
    // The point of the whole ruling: not merely that it failed, but that NO CPU WAS SPENT.
    expect(separateNeural).not.toHaveBeenCalled();
  });

  it("separates when this device IS the authority (the solo/host path is unchanged)", async () => {
    setSeparationAuthority(() => true);
    await loadStems(fakeCtx, "vid00000002", fakeMix, MODEL);
    expect(separateNeural).toHaveBeenCalledTimes(1);
  });

  it("re-reads the predicate per call, so a moving anchor is honoured immediately", async () => {
    // The anchor moves mid-session (a host refresh hands the clock to its own phone and takes
    // it back). A snapshotted role would be stale exactly when it matters, so the module holds
    // a PREDICATE, not a boolean. Flip it between calls and both answers must change.
    let allowed = false;
    setSeparationAuthority(() => allowed);
    await expect(loadStems(fakeCtx, "vid00000003", fakeMix, MODEL)).rejects.toBeInstanceOf(
      NotSeparationAuthority,
    );
    expect(separateNeural).not.toHaveBeenCalled();
    allowed = true;
    await loadStems(fakeCtx, "vid00000003", fakeMix, MODEL);
    expect(separateNeural).toHaveBeenCalledTimes(1);
  });

  it("refuses a FORCED re-analyze too — force skips the cache, not the ruling", async () => {
    // force=true bypasses the manifest probe entirely, so it never meets the cold-cache gate
    // in deriveStems. If the authority check lived only there, Settings ▸ Re-analyze would be
    // a way for any guest to hand itself a full separation.
    setSeparationAuthority(() => false);
    await expect(
      loadStems(fakeCtx, "vid00000004", fakeMix, MODEL, undefined, true),
    ).rejects.toBeInstanceOf(NotSeparationAuthority);
    expect(separateNeural).not.toHaveBeenCalled();
  });
});
