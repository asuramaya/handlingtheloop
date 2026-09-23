import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { seatOf, type Attachment } from "./seatOf";
import { canDriveIntent, type Intent, type DeckId } from "./protocol";
import { canDriveDeck, canDriveBoard } from "../../App/drivePermission";

// ★ ONE RULE, DECIDED TWICE, ON OPPOSITE SIDES OF A WIRE — and thread bb03b26e listed "a granted
// guest's drive" as untested and waiting on two real devices. It is not: both halves are pure, the
// server's own code enumerates every attachment it can produce, and agreement over that set is a
// question a test can answer completely. Two browsers would sample it; this exhausts it.
//
// The failure being excluded is specific and it is the one the whole guard programme exists for:
// the server DROPS an out-of-lane intent (room.ts:797) and its own comment notes the sender "already
// applied it locally". So a client that permits one keystroke more than the server does not get an
// error — it gets a deck that moved here and not there, silently (71277a23).

const DECKS = ["", "A", "B", "AB"] as const;
const deckIntent = (deck: DeckId): Intent => ({ kind: "control", deck, param: "tempo", value: 1 }) as Intent;
const boardIntent = (): Intent => ({ kind: "crossfade", value: 0.5 }) as Intent;

// ★ THE REACHABLE SET, NOT THE CROSS-PRODUCT — and my first version of this test got that wrong,
// which is the error this repo keeps re-learning in new clothes. Enumerating all 16 combinations of
// (decks × stage × controlling) reported ten "disagreements", every one of them a state the server
// cannot produce: `controlling: true` with `decks: ""` never occurs because the server writes those
// two fields in the same literal, and a single deck without `stage: true` never occurs because
// room.ts:1348 is the only site that grants one. A test failing on unreachable states earns itself an
// exemption list, which is the roster problem wearing a third face.
//
// So the population is defined by INVARIANTS SCANNED OUT OF THE SERVER (below), and the agreement
// runs over the states that satisfy them. The scan is the load-bearing half: if a future commit
// breaks an invariant, a new state becomes reachable and the scan says which line did it.

/** What the server's own writes guarantee about an attachment.
 *
 *  ★ THIS USED TO HAVE TWO CLAUSES. The first was `a.controlling === (a.decks !== "")`, and the scan
 *  that was meant to establish it compared `/^""$/` against `/^false$/` — so it only ever checked the
 *  biconditional when BOTH values were literals, and every live write in room.ts is a ternary or a
 *  variable. Measured against the scan's own body: an INVERTED pairing walked through. A regex cannot
 *  evaluate an expression, so no sharper scan was going to close it.
 *
 *  `controlling` is derived from `decks` now (roomState.drivesAnything, seatOf), so clause 1 is not a
 *  fact this filter has to assume — there is no second field to disagree with the first. What remains
 *  is the one invariant that is still a real coupling between two fields. */
const reachable = (a: Attachment): boolean =>
  // a single-deck grant always carries `stage: true` (room.ts:1348, the only such site).
  !(a.decks === "A" || a.decks === "B") || a.stage;

describe("the client's permission and the server's cannot disagree", () => {
  test("★ they agree on every attachment the server can actually produce", () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const decks of DECKS) {
      for (const stage of [false, true]) {
          const me: Attachment = { decks, stage };
          if (!reachable(me)) continue;
          checked++;
          const seat = seatOf(me, { enabled: true, floorListener: false });
          // The server resolves permission from `decks` alone, off a joined+controlling socket
          // (room.ts:1267-1273).
          for (const id of ["A", "B"] as DeckId[]) {
            const client = canDriveDeck(seat, id);
            const server = canDriveIntent(decks, deckIntent(id));
            if (client !== server) mismatches.push(`decks="${decks}" stage=${stage} deck ${id}: client ${client}, server ${server}`);
          }
          const clientBoard = canDriveBoard(seat);
          const serverBoard = canDriveIntent(decks, boardIntent());
          if (clientBoard !== serverBoard) mismatches.push(`decks="${decks}" stage=${stage} BOARD: client ${clientBoard}, server ${serverBoard}`);
      }
    }
    // ★ NOT `toHaveLength(0)` — the message IS the finding. A bare count would say "they disagree"
    // and make the reader re-derive which state, which is the errand every guard in this repo has
    // been rewritten to stop sending people on.
    expect(mismatches.join("\n")).toBe("");
    // …and the filter must not have emptied the population, which would pass while checking nothing.
    expect(checked, "the reachability filter excluded every state").toBeGreaterThanOrEqual(6);
  });

  test("a floor listener with no roster entry drives nothing, whatever the wire says", () => {
    const seat = seatOf({ decks: "AB", stage: true }, { enabled: true, floorListener: true });
    expect(canDriveDeck(seat, "A")).toBe(false);
    expect(canDriveBoard(seat)).toBe(false);
  });

  test("a SOLO rig drives everything — the seat rules bind only inside a room", () => {
    const seat = seatOf(null, { enabled: false, floorListener: false });
    expect(canDriveDeck(seat, "A")).toBe(true);
    expect(canDriveBoard(seat)).toBe(true);
  });
});

describe("the coupling the agreement above silently rests on", () => {
  // ★ `myDeck: null` IS A COLLAPSE: it means "holds both decks", "holds no particular deck" and
  // "is not on stage" at once. The states above agree only because the ONE server site that grants a
  // single deck also sets `stage: true` in the same object literal (room.ts:1348). Nothing on either
  // side states that, and the agreement test cannot notice it breaking — it enumerates states, and
  // the break would be a new state becoming REACHABLE.
  const room = readFileSync(new URL("../../../server/room.ts", import.meta.url), "utf8");

  test("here is what the collapse would cost, if the coupling were ever broken", () => {
    // Not hypothetical prose: the actual divergence, measured through both real predicates.
    const bad: Attachment = { decks: "B", stage: false };
    const seat = seatOf(bad, { enabled: true, floorListener: false });
    expect(seat.myDeck).toBeNull(); // the collapse
    expect(canDriveDeck(seat, "A")).toBe(true); // the client would allow deck A…
    expect(canDriveIntent("B", deckIntent("A"))).toBe(false); // …and the server would drop it.
  });

  test("★ every single-deck grant on the server sets `stage` in the same breath", () => {
    const offenders: string[] = [];
    const lines = room.split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/\bdecks:\s*([^,}]+)/);
      if (!m) return;
      const value = m[1].trim();
      // "" and "AB" (and the ternaries between them) collapse safely — myDeck is null either way and
      // canDriveDeck then matches canDriveIntent exactly. `{ t: "tick", decks: … }` is the playback
      // tick, a different `decks` entirely, and carries no permission.
      if (/^""$/.test(value) || /"AB"/.test(value) || /^msg\.decks$/.test(value)) return;
      if (!/\bstage:\s*true/.test(line)) {
        offenders.push(
          `server/room.ts:${i + 1} writes decks=${value} without \`stage: true\` in the same literal — ` +
            `the client collapses that to myDeck=null and would permit BOTH decks while the server permits one`,
        );
      }
    });
    expect(offenders.join("\n")).toBe("");
  });

  // ★ THE CO-OCCURRENCE SCAN THAT STOOD HERE IS GONE, and not because it was tidied away: the fact
  // it checked can no longer be false. It asserted `controlling` and `decks` are written together,
  // by comparing /^""$/ against /^false$/ — which is the biconditional only when BOTH values are
  // literals, and every live write in room.ts is a ternary or a variable. Run against its own body,
  // an INVERTED pairing (`controlling: !on, decks: on ? "AB" : ""`) passed, as did both real lines,
  // for the same syntactic reason. Its green said nothing about any line it protected.
  //
  // `controlling` is derived from `decks` now (roomState.drivesAnything), so there is no second
  // field to keep in step and nothing for a scan to check. A regex could not evaluate an expression;
  // deleting the expression worked.

  test("the scan has something to find (vacuity guard)", () => {
    // If room.ts stops writing a single-deck grant at all, the test above passes by emptiness and
    // the reader learns nothing. This says which it is.
    const singleDeckGrants = room.split("\n").filter((l) => /\bdecks:\s*(deck\b|"A"|"B")/.test(l) && !/msg\.decks/.test(l));
    expect(singleDeckGrants.length, "no single-deck grant found in room.ts — the scan above is vacuous").toBeGreaterThan(0);
  });
});

describe("a STAGE DJ and the whole board", () => {
  // ★ THE READER SWEEP METRON HANDED ME FOUND A LIVE ONE, and it is the guard existing while nothing
  // asks — shape 1b, from my own standing practices. canDriveBoard has said since it was written
  // that the crossfader "needs FULL control — never a stage DJ, never a follower". Its only consumer
  // was a `locked:` prop driving pointer-events, which App.tsx's own comment one screen away calls
  // out as not a guard ("a control that works because something sits over it is not guarded").
  //
  // The handler guarded on `lockedRef` = (enabled && !controlling) || replay — the FOLLOWER lock. A
  // stepped-up listener holds controlling=true, so it passed: the local engine moved and the server
  // dropped the intent, because a crossfade carries no deck and canDriveIntent then demands BOTH.
  // Silent divergence on the shared board, from the seat one role up (71277a23).
  const stageDj = seatOf({ decks: "B", stage: true }, { enabled: true, floorListener: false });

  test("holds their own deck", () => {
    expect(canDriveDeck(stageDj, "B")).toBe(true);
  });

  test("★ is refused the crossfader — and the server agrees, which is the whole point", () => {
    expect(canDriveBoard(stageDj)).toBe(false);
    expect(canDriveIntent("B", boardIntent())).toBe(false);
  });

  test("the FOLLOWER lock would have let them through — it is a different question", () => {
    // The predicate the handler actually used, reconstructed: (enabled && !controlling) || replay.
    const followerLock = (seat: { enabled: boolean; controlling: boolean }, replay = false) => (seat.enabled && !seat.controlling) || replay;
    expect(followerLock(stageDj)).toBe(false); // …so it did NOT lock, which is the defect
    expect(canDriveBoard(stageDj)).toBe(false); // …while the board rule did.
    // Both predicates are correct about their own question. Using one where the other belongs is
    // what shipped, and no test could see it while the board rule had no caller but a CSS prop.
  });

  test("a full controller is refused nothing", () => {
    const host = seatOf({ decks: "AB", stage: false }, { enabled: true, floorListener: false });
    expect(canDriveBoard(host)).toBe(true);
    expect(canDriveIntent("AB", boardIntent())).toBe(true);
  });
});

describe("the board lock reaches the handlers, not just the CSS", () => {
  // The defect was not the rule, it was that nothing asked it. So the assertion is about CALLERS —
  // the same shape as duckTap.test.ts, which pins that a helper is CALLED rather than re-testing it.
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const midi = readFileSync(new URL("../../App/useMidiRouting.ts", import.meta.url), "utf8");

  test("the on-screen crossfader guards on the BOARD lock, not the follower lock", () => {
    const drag = app.slice(app.indexOf("const dragCrossfade"), app.indexOf("const dragCrossfade") + 900);
    expect(drag).toMatch(/boardLockedRef\.current/);
    expect(drag, "dragCrossfade is back on the follower lock, which a stage DJ passes").not.toMatch(/if \(lockedRef\.current\) return;/);
  });

  test("the HARDWARE crossfader guards too — it had no board check at all", () => {
    expect(midi).toMatch(/boardLockedRef\.current/);
  });

  test("★ the MUTATOR guards, not only the callers — seven AutoMixer sites reach it directly", () => {
    // 5dd05b9 guarded dragCrossfade and claimed "at the mutator". dragCrossfade is a CALLER.
    // applyCrossfade is the canonical path and the AutoMixer reaches it through autoDeps, so the
    // guard on the visible fader bought nothing for the seven invisible entries. Asserting the
    // mutator specifically, because a guard on every caller is a roster and the next caller joins
    // ungated.
    const apply = app.slice(app.indexOf("const applyCrossfade = useCallback"), app.indexOf("const dragCrossfade"));
    expect(apply, "applyCrossfade no longer guards — a caller-side guard is one new caller from useless").toMatch(/boardLockedRef\.current/);
  });
});
