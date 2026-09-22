// PLATFORM FACTS ABOUT THE DURABLE OBJECT, owned by neither the audio side nor the room side.
//
// This lived as a hand-written literal in three places and, briefly, inside stemViewBudget.ts —
// which was a naming lie: a Durable Object's per-value cap is not a stem-view fact. It is a
// property of the runtime that several unrelated caches happen to bump into, so it belongs in a
// module that claims nothing else.

/** A single Durable Object storage VALUE may not exceed 128 KiB. Everything persisted under one
 *  key is measured against this.
 *
 *  ★ IF YOU EVER LOWER THIS, OR ADD A TIGHTER PER-RECORD BUDGET, READ THIS FIRST. Live data was
 *  written under WHATEVER CAP WAS IN FORCE AT THE TIME, and at least one migration's safety rests
 *  on the fact that this number has only ever RELAXED — lyrics' original persist capped at a
 *  hand-written 120_000 (6023efd), tighter than this, so every legacy `lyrics` record on disk is
 *  smaller than today's limit and room.ts's two-phase split can write both halves without
 *  re-checking either. Tighten the cap and that stops being true: a legacy value written under the
 *  looser one can exceed the new one, the unchecked put throws, the catch swallows it, and one
 *  deck's captions become unreachable on disk while the legacy record sits there unread (found by
 *  Deckard reviewing 4717b13; ruling 4450a6b9).
 *
 *  A cap can always be RAISED safely. Lowering one is a data migration wearing a constant. */
export const DO_VALUE_CAP = 128 * 1024;
