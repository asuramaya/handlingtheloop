// THE LISTENER DIGEST KEY — which continuous updates collapse into one another.
//
// Listeners do not get the performer relay. Continuous sweeps are coalesced last-value-per-key at
// ~20 Hz (room.ts queueDigest) so a rack of FX moves doesn't fan out at input rate. The KEY decides
// what counts as "the same control", so getting it wrong does not drop frames visibly — it silently
// merges two different controls into one and the listener sees one of them freeze.
//
// THE BUG THIS FIXES: the key was `kind:deck:param`. For an fxParam that ignores BOTH `chain` and
// `fx`, and never reaches `slot` because param is always present. protocol.ts already establishes
// (in its own comment, for the intent itself) that a slot stopped being an address when stem chains
// arrived and that chain + fx is the real one — but that lesson lived only in the intent's
// addressing and never reached the digest. `mix` is the GENERIC wet/dry exposed across devices
// (Eq3 handles it, CompFx sets it, ModFx defaults it, and the hardware BEAT-FX knob drives it on
// whatever device is focused), so a reverb in the vocals chain and a delay on master, both on deck
// A, both swept, produced the SAME key and the Map kept only the last.
//
// Pure and exported so it can be tested; the DO holds no state this needs.

import type { Intent } from "./protocol";

/** The address an intent collapses on for the listener digest. */
export function digestKey(i: Intent): string {
  const a = i as unknown as Record<string, unknown>;
  // An FX device's portable address is chain + kind (protocol.ts: "ids are per-deck sequence
  // numbers", so `chain` NAME plus `fx` KIND is the pair that survives a trip). Fall back to the
  // slot when an older peer sent neither, which is exactly the back-compat case fxParam's own
  // optional fields exist for — never to the bare param, which is what collided.
  if (i.kind === "fxParam" || i.kind === "fxBypass") {
    const addr = a.chain !== undefined || a.fx !== undefined ? `${a.chain ?? ""}/${a.fx ?? ""}` : `slot${a.slot ?? ""}`;
    return `${i.kind}:${a.deck ?? ""}:${addr}:${a.param ?? ""}`;
  }
  return `${i.kind}:${a.deck ?? ""}:${a.param ?? a.stem ?? a.slot ?? ""}`;
}
