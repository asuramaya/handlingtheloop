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

/** The two things the server's own writes guarantee about an attachment. */
const reachable = (a: Attachment): boolean =>
  // 1. `controlling` and `decks` are written together: control iff some deck.
  a.controlling === (a.decks !== "") &&
  // 2. a single-deck grant always carries `stage: true` (room.ts:1348, the only such site).
  (!(a.decks === "A" || a.decks === "B") || a.stage);

describe("the client's permission and the server's cannot disagree", () => {
  test("★ they agree on every attachment the server can actually produce", () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const decks of DECKS) {
      for (const stage of [false, true]) {
        for (const controlling of [false, true]) {
          const me: Attachment = { controlling, decks, stage };
          if (!reachable(me)) continue;
          checked++;
          const seat = seatOf(me, { enabled: true, floorListener: false });
          // The server resolves permission from `decks` alone, off a joined+controlling socket
          // (room.ts:1267-1273).
          for (const id of ["A", "B"] as DeckId[]) {
            const client = canDriveDeck(seat, id);
            const server = canDriveIntent(decks, deckIntent(id));
            if (client !== server) mismatches.push(`decks="${decks}" stage=${stage} controlling=${controlling} deck ${id}: client ${client}, server ${server}`);
          }
          const clientBoard = canDriveBoard(seat);
          const serverBoard = canDriveIntent(decks, boardIntent());
          if (clientBoard !== serverBoard) mismatches.push(`decks="${decks}" stage=${stage} controlling=${controlling} BOARD: client ${clientBoard}, server ${serverBoard}`);
        }
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
    const seat = seatOf({ controlling: true, decks: "AB", stage: true }, { enabled: true, floorListener: true });
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
    const bad: Attachment = { controlling: true, decks: "B", stage: false };
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

  test("★ control and decks are written together — neither is ever set without the other", () => {
    // Invariant 1 of `reachable`. If a patch ever sets `controlling: true` while leaving decks "",
    // the client grants both decks and the server grants none: every control dead, silently.
    const offenders: string[] = [];
    room.split("\n").forEach((line, i) => {
      const d = line.match(/\bdecks:\s*([^,}]+)/);
      const c = line.match(/\bcontrolling:\s*([^,}]+)/);
      if (!d || /^msg\.decks$/.test(d[1].trim())) return;
      if (!c) return; // a patch touching only decks is covered by the stage scan below
      const decksEmpty = /^""$/.test(d[1].trim());
      const ctlFalse = /^false$/.test(c[1].trim());
      if (decksEmpty !== ctlFalse) offenders.push(`server/room.ts:${i + 1} sets controlling=${c[1].trim()} beside decks=${d[1].trim()}`);
    });
    expect(offenders.join("\n")).toBe("");
  });

  test("the scan has something to find (vacuity guard)", () => {
    // If room.ts stops writing a single-deck grant at all, the test above passes by emptiness and
    // the reader learns nothing. This says which it is.
    const singleDeckGrants = room.split("\n").filter((l) => /\bdecks:\s*(deck\b|"A"|"B")/.test(l) && !/msg\.decks/.test(l));
    expect(singleDeckGrants.length, "no single-deck grant found in room.ts — the scan above is vacuous").toBeGreaterThan(0);
  });
});
