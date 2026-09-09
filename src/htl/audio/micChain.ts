// ── THE MIC'S CHAIN ───────────────────────────────────────────────────────────────────────────
//
// ★ OPERATOR RULING (0708130a, refined this session): the mic is "just another chain", and its
// chain appears ON DEMAND when the mic is on — "same thing" as AUTO's, which is offered the first
// time AUTO actually runs.
//
// So this is AUTO's contract, deliberately, line for line (autoMixer.ts `autoChainOf`):
//   • Seeded ONCE per device, at the moment the thing it serves first happens — for AUTO that is a
//     transition, for the mic it is pointing the mic at a deck's rack.
//   • Seeded with a starting device the user is expected to replace, and NEVER written to again.
//     The system does not own a param in here; whatever they have dialled is what plays.
//   • `seeded` is STICKY, so deleting the chain is how you turn the feature off — rather than
//     fighting a mixer that keeps putting it back. That flag is the whole reason this cannot live
//     in the audio layer alone: it is user intent, and it belongs in settings beside autoFx.seeded.
//
// Routing to "master" seeds nothing. The master route is the PA talkover — it never touches a
// deck's rack at all, so there is no rack for a chain to appear in.
import type { Deck } from "./Deck";
import type { FxChain } from "./Fx";

export const MIC_CHAIN = "MIC";

/** The deck's existing MIC chain, or null. Looked up by NAME — the same identity the rack's
 *  reserved-region rule and AutoMixer both use, so this adds no new notion of one. */
export function micChainOf(deck: Deck): FxChain | null {
  return deck.rack.chainList.find((c) => !c.master && c.name === MIC_CHAIN) ?? null;
}

/** Offer the MIC chain on `deck`. Returns the chain when one now exists, null when the offer has
 *  already been made and declined (`seeded` && deleted). Idempotent: an existing chain is returned
 *  untouched — no device added, no param written, however many times the mic is re-routed here. */
export function seedMicChain(deck: Deck, seeded: boolean): FxChain | null {
  const existing = micChainOf(deck);
  if (existing) return existing;
  if (seeded) return null; // offered once already, and they removed it
  const chain = deck.addFxChain(MIC_CHAIN, 0); // claims no stems — it is fed by micIn, not a tap
  deck.addFxTo(chain.id, "reverb"); // a starting point they can replace; we never touch it again
  return chain;
}
