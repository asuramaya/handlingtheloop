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

  test("★ control and decks are written together — NEITHER is ever set without the other", () => {
    // Invariant 1 of `reachable`, and the scan that checks it had the defect it was checking for.
    //
    // ★ MY FIRST VERSION REQUIRED A `decks:` MATCH BEFORE IT LOOKED AT A LINE AT ALL, so a site
    // writing `controlling: true` with no `decks` was invisible to it — which is the one direction
    // that actually hurts: the client reads controlling=true, myDeck=null and permits BOTH decks,
    // while the server resolves decks="" and permits none. Every control dead or, worse, every
    // control moving this device only. The scan was guarding one side of a co-occurrence by
    // requiring the other side to be present, which cannot ever fail in the dangerous direction.
    //
    // Metron's shape, three times tonight and now a fourth: the FIX was correct and its EDGE was
    // assumed rather than exercised. Found by asking what my own instrument could not see, before
    // he reviewed it.
    const offenders: string[] = [];
    room.split("\n").forEach((line, i) => {
      const d = line.match(/\bdecks:\s*([^,}]+)/);
      const c = line.match(/\bcontrolling:\s*([^,}]+)/);
      // `{ t: "tick", decks }` is the playback tick — a different `decks` entirely, no permission.
      const permissionDecks = d && !/^msg\.decks$/.test(d[1].trim());
      if (!permissionDecks && !c) return;
      if (c && !permissionDecks) {
        offenders.push(`server/room.ts:${i + 1} writes controlling=${c[1].trim()} with NO decks — the client would permit both decks while the server permits none`);
        return;
      }
      if (permissionDecks && !c) return; // decks-only patches are covered by the stage scan below
      const decksEmpty = /^""$/.test(d![1].trim());
      const ctlFalse = /^false$/.test(c![1].trim());
      if (decksEmpty !== ctlFalse) offenders.push(`server/room.ts:${i + 1} sets controlling=${c![1].trim()} beside decks=${d![1].trim()}`);
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
  const stageDj = seatOf({ controlling: true, decks: "B", stage: true }, { enabled: true, floorListener: false });

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
    const host = seatOf({ controlling: true, decks: "AB", stage: false }, { enabled: true, floorListener: false });
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
});
