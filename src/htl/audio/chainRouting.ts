// Is a stem chain actually ROUTED, or is it sitting there doing nothing?
//
// ★ THE SILENT WAIT THIS EXISTS TO END. A stem chain needs separated stems to hear anything. With
// none, Deck.syncStemTaps hands the rack a null stem source, FxRack.rebuild finds no tap it can
// reach, and its fallback feeds the sum the whole signal instead — so the deck plays perfectly
// normally, the master chain still works, and every stem chain is INERT. That fallback is the right
// call (the alternative is a "drums" chain processing the entire track, which looks routed and
// sounds wrong) but until now nothing said so anywhere the user could see.
//
// It was worse than merely unsaid. The strip HIDES a chain's stem letters when nothing is
// separated — correctly, on its own terms: "with nothing separated there is nothing to preview,
// four dead letters on every chip is noise that looks like state". So the one surface that could
// have explained the inert chain went blank in exactly the case that needed explaining. The
// operator hit it precisely as predicted: "chain 1 add reverb, apply to vocals, nothing going
// through the chain. so far only the master seems to work properly."
import type { FxChain } from "./Fx";

/** The chain claims stems, but this deck has none — so it is configured, holding devices, and
 *  hearing silence. Not an error state: it starts working the moment stems land, which is why the
 *  honest word is WAITING rather than broken. */
export function chainWaitingForStems(chain: Pick<FxChain, "stems" | "master">, hasStems: boolean): boolean {
  return !chain.master && chain.stems !== 0 && !hasStems;
}

/** Any chain waiting. What the strip needs to decide whether to explain itself at all. */
export function anyChainWaitingForStems(
  chains: ReadonlyArray<Pick<FxChain, "stems" | "master">>,
  hasStems: boolean,
): boolean {
  return chains.some((c) => chainWaitingForStems(c, hasStems));
}

/** A chain that will never hear anything because it claims NO stems — distinct from waiting, and
 *  already surfaced as the "deaf" class. Separated here so the two states cannot be conflated:
 *  a deaf chain needs a stem SELECTION, a waiting chain needs a SEPARATION. Different fixes, so
 *  they must not share one message. The master is neither — it takes the sum, after the chains. */
export function chainIsDeaf(chain: Pick<FxChain, "stems" | "master">): boolean {
  return !chain.master && chain.stems === 0;
}
