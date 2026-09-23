# An origin on the deck write path

**Status: DRAFT, for Metron to knock down.** Nothing here is built. Thread `ba5eb70e`; both names
are on the reframing (DM 13780 → 13782), neither is on a shape yet.

## Why the question changed

`bothDeckActionScan` was widened seven times. Each widening was correct and each found something
real, and the thread still had two candidate futures: a TypeScript-compiler-based check, or moving
the guard to the mutator so the defect is unrepresentable.

Counting the populations settled it — `scripts/deckscan/coverage.mjs`, run rather than remembered:

| | |
|---|---|
| Deck public writers declared | 182 |
| deck-mutation sites in App.tsx | 136 |
| both-deck LOOPS the scan examines | **10** |

Attribution, because the aggregate reads as a catastrophe and it is not one: 91 `AppBody` (the real
driving surface, gated at dispatchers far above any loop), 22 `applyDeckRack`, 15
`applyDeckControls`, 3 `applyDeckStems`, 5 `deckSnapshot` (read-only methods the writer split cannot
tell from writes — it errs loud on purpose). **One design question and five false positives.**

The 40 applier sites decide it. `applyDeckControls` writes `setTempo`, `setPitch`, `cuePoint`,
`hotCues`, `loop`, `seek` and `play` from a `DeckSnapshot`, and it must **never** ask
`canDriveDeck` — it is applying authority received from the room, not exercising it. A follower that
gated it would stop following.

So drive permission is a property of the **caller's intent** — originating a change versus applying
one received. That is not a fact about the deck, the method, or the syntax around it, which is why
both candidate futures failed in the same place: a compiler owns *"is this a `Deck`"*, a type fact,
but *"is this call originating or applying"* is not one; and a mutator guard makes the defect
unrepresentable **and** makes following unrepresentable. Neither could express the thing it needed.

## Three ways to avoid an origin, all dead

Metron attacked the claim rather than agreeing with it. Recorded because a rejected shape with a
reason is worth more than an unexamined one, and the next reader will think of all three.

- **By function roster** — whitelist the appliers. Dead: *the same method is reached from both
  sides*. `seek` is applying from a `DeckSnapshot` and originating when the user drags the waveform.
  A function-level roster cannot separate them, and a per-call-site roster is the exemption list
  this thread already rejected, wearing a new name.
- **By reachability** — *applying* = reachable from an inbound room message, *originating* =
  reachable from a local input event. The most promising, and it dies on the same fact: the
  interesting functions are reachable from **both**, so reachability partitions the call graph and
  not the calls. It also wants whole-program analysis to answer what a one-word argument answers.
- **By ambient flag** — a module-level "we are currently applying", set by the room handler around
  its writes. Dead for a reason specific to this codebase: the load and apply paths `await`, and an
  ambient flag leaks across a suspension point to whatever resumes next. That converts a permission
  bug into an *intermittent* permission bug, which is strictly worse than the one we have. Dynamic
  scope is the wrong tool where there are suspension points.

## The dependency this design must record

**"Appliers never gate" is a conclusion about the server, not a property of appliers.** It is safe
only because an intent a device may not send never becomes authoritative: `server/room.ts:797`,
`if (!this.canDrive(self, msg.intent)) break;`, deferring to the pure per-deck `canDriveIntent`
(`src/htl/room/protocol`) at 1267-1273. Verified independently, not relayed.

The client therefore has **no second line, by design** — and that is the right call, since a
follower that second-guesses the room is the bug we are avoiding. What is not right is leaving it
unstated, so whichever shape wins must carry that sentence where a reader of the applier will hit
it.

Pinned meanwhile by `server/intentGate.test.ts`: every path that turns an inbound message into a
broadcast `t: "intent"` must pass `canDrive` in its own handler. There is exactly one such path
today; the test is written to find a **second** one rather than to pin the count at 1, and it fails
both when the gate is deleted and when an ungated broadcast path is added.

## The three shapes

Each must answer the same four questions: can an applier write without a permission check; is an
ungated originating write a *compile* error or a runtime one; what does it cost at the 136 sites;
and where does the server-dependency sentence live.

### A. Drive handle

`engine.deck(id)` returns a read/apply view. Originating code must first obtain
`engine.driveDeck(id)`, which returns `null` when this device may not drive it — so the permission
check is the only way to get an object with the mutators on it.

- Applier writes: unchanged, they hold the plain `Deck`.
- Ungated originating write: **compile error** — the mutators are not on the applier's type.
- Cost: every originating site changes shape (`const d = engine.driveDeck(id); if (!d) return;`).
  91 `AppBody` sites, most already inside a gated dispatcher, so many collapse to a rename.
- Weakness: two types for one object invites `as`, and nothing stops an applier from being handed
  a drive handle. It makes the defect *inconvenient*, not impossible.

### B. Explicit origin argument

Every Deck mutator takes an origin: `deck.setTempo(v, "local")` vs `deck.setTempo(v, "remote")`.
The Deck itself consults the permission for `"local"` and never for `"remote"`.

- Ungated originating write: **compile error** at every call site that omits the argument (182
  writers, so this is the large one).
- Cost: the largest. It also puts a permission dependency inside `Deck`, which currently knows
  nothing about rooms — a layering cost worth pricing before anyone likes this.
- Strength: no second type, no way to launder it, and the origin is visible at the site where a
  reader is deciding whether the call is right.

### C. Two façades

One `Deck` object, two exported interfaces over it: `DeckApply` (all writers, no permission
concept) and `DeckDrive` (the same writers, each gated). The room applier imports one, `AppBody`
imports the other, and the import itself is the declaration of intent.

- Ungated originating write: a **lint/scan** error (which file imported which façade), not a
  compile error — weaker than A and B, and this thread's whole history is scans being weaker than
  they look.
- Cost: lowest. Strength: the origin is legible per *module*, which matches how the code is
  actually split today.

### What I would build, if forced to choose now

**A**, and add B's argument only for the writers an applier never touches. A is the only one whose
cost lands mostly on sites that already have a gate one frame up, and its weakness (`as`) is the
kind a scan *can* catch, unlike the weaknesses this thread has been failing to catch for seven
turns. But this is a draft, and the point of it is for Metron to knock one down.
