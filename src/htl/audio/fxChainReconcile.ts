// WHAT THE STEM CHAINS MUST BECOME — the decision, extracted from the doing.
//
// ★ THE BUG THIS EXISTS TO KILL. applyFxChainSnapshot has a fast path that writes params in place
// when the STRUCTURE already matches, and its comment is exactly right about why:
//
//     ★ DON'T REBUILD WHAT ALREADY MATCHES. Tearing the chains down and re-adding them destroys
//     live AudioNodes — a reverb tail, a delay's feedback, a gate mid-cycle …
//
// But the moment the structure does NOT match, the else-branch removes EVERY non-master chain and
// rebuilds all of them from scratch. So the one gesture the operator actually reported — "chain 1
// add reverb, apply to vocals" — is precisely the gesture that changes structure, and on every
// peer it destroys the live nodes of every OTHER chain too. Correct membership by the wrong method:
// the thing the fast path exists to prevent, happening on the only path that ever adds a device.
//
// The right unit is the CHAIN, not the whole list: chains the snapshot still names keep their audio
// and reconcile their devices; only genuinely new chains are built and genuinely absent ones die.
//
// ★ WHY PURE, and this is the lesson from rackDelta rather than a style preference: nothing
// instantiates a real Deck in the node suite (it needs an AudioContext), so anything left inside
// Deck is untestable and was historically untested. Worse, roomSim's FakeDeck reimplemented the
// same intent by a different method and passed while the real code failed. Putting the DECISION
// here lets both run the same algorithm and lets the suite test it.

import type { FxChainSlot } from "../room/protocol";

/** The shape this needs from a live chain — the real FxChain and any fake both have it. */
export interface LiveChain {
  id: string;
  name: string;
  stems: number;
  /** Device kinds, in order. */
  devices: readonly string[];
}

export interface ChainPlan {
  /** Chain ids to remove wholesale — the snapshot no longer names them. */
  remove: string[];
  /** Chains to build from nothing, in snapshot order. */
  add: FxChainSlot[];
  /** Chains that survive. Their live AudioNodes MUST NOT be torn down. */
  keep: Array<{
    id: string;
    snapshot: FxChainSlot;
    /** Device kinds to create in this chain. */
    addDevices: string[];
    /** Device kinds to delete from this chain. A stem chain has no undeletable residents — unlike
     *  the master chain, whose eq and comp are permanent (see UNDELETABLE_MASTER_KINDS). */
    removeDevices: string[];
    /** The kind order the sender has, for a caller that can reorder in place. */
    order: string[];
    /** Whether the stem claim changed — worth not re-writing when it did not, since setFxChainStems
     *  re-partitions ownership across chains. */
    stemsChanged: boolean;
  }>;
}

/** Match live chains to snapshot chains BY NAME.
 *
 *  Name, not id: ids are per-deck sequence numbers (`c${chainSeq++}`) and mean nothing on another
 *  machine — the same reason fxWireAddrAt puts the chain NAME on the wire. Duplicate names are
 *  matched first-come and consumed, so two chains called "vocals" pair up one-to-one rather than
 *  both binding to the same snapshot entry.
 *
 *  `known` filters device kinds this build understands. An unknown kind is not a removal
 *  instruction — the same rule rackDelta states — so it never reaches removeDevices, and it is not
 *  added either. */
export function chainPlan(current: readonly LiveChain[], snapshot: readonly FxChainSlot[], known?: ReadonlySet<string>): ChainPlan {
  const unclaimed = current.map((c, i) => ({ c, i, taken: false }));
  const plan: ChainPlan = { remove: [], add: [], keep: [] };

  for (const s of snapshot) {
    const hit = unclaimed.find((e) => !e.taken && e.c.name === s.name);
    if (!hit) {
      plan.add.push(s);
      continue;
    }
    hit.taken = true;
    const wantKinds = s.devices.map((d) => d.kind).filter((k) => !known || known.has(k));
    const haveKinds = hit.c.devices.filter((k) => !known || known.has(k));
    const have = new Set(haveKinds);
    const want = new Set(wantKinds);
    plan.keep.push({
      id: hit.c.id,
      snapshot: s,
      addDevices: wantKinds.filter((k) => !have.has(k)),
      removeDevices: haveKinds.filter((k) => !want.has(k)),
      order: wantKinds,
      stemsChanged: (hit.c.stems ?? 0) !== (s.stems ?? 0),
    });
  }

  for (const e of unclaimed) if (!e.taken) plan.remove.push(e.c.id);
  return plan;
}

/** True when the plan would change nothing structural — every chain survives with its exact
 *  membership and stem claim. The caller can then take the cheap params-in-place path. */
export function planIsStructural(plan: ChainPlan): boolean {
  if (plan.add.length || plan.remove.length) return true;
  return plan.keep.some((k) => k.addDevices.length > 0 || k.removeDevices.length > 0 || k.stemsChanged);
}
