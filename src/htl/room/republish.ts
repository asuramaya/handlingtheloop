// What a device answers when the ROOM asks it to republish — it has just taken the anchor slot, and
// `state` is only ever accepted from the anchor, so a publish made a moment before that slot arrived
// was dropped in silence with nothing to ask for it again.
//
// ★ THE RULE, AND WHY IT IS NOT JUST "SEND THE LAST ONE". The first version answered only from the
// last published snapshot, which is empty on a FRESHLY LOADED page — so a host reload, the case the
// frame exists for, answered the ask with nothing at all. Caught on the rig rather than in review.
// Asking the app for the board as it stands NOW covers that, and is more truthful than a cache
// whenever the two differ; the cached copy stays as the fallback for a client with no provider.
//
// Silence remains a legitimate answer: a device that genuinely has no board should not invent one,
// because whatever it sends becomes what the room serves every later joiner.
export function republishSnapshot(fresh: unknown, lastPublished: unknown): unknown {
  return fresh !== undefined ? fresh : lastPublished;
}
