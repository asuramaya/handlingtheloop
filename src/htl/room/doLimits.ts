// PLATFORM FACTS ABOUT THE DURABLE OBJECT, owned by neither the audio side nor the room side.
//
// This lived as a hand-written literal in three places and, briefly, inside stemViewBudget.ts —
// which was a naming lie: a Durable Object's per-value cap is not a stem-view fact. It is a
// property of the runtime that several unrelated caches happen to bump into, so it belongs in a
// module that claims nothing else.

/** A single Durable Object storage VALUE may not exceed 128 KiB. Everything persisted under one
 *  key — a whole two-deck record, not one deck — is measured against this. */
export const DO_VALUE_CAP = 128 * 1024;
