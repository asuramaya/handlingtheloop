// FOLLOWLAB — what a phone listener's screen actually DOES while a host mixes.
//
// The operator ruled that a listener's view follows the host, and then named the difficulty
// themselves: "the desktop host can see both decks and fx at once, mobile can only see one deck,
// and fx only when opened, so it's not as obvious as it seems at first." The follow rule that came
// out of that (App/listenerFocus.ts) is three numbers, and I recorded them as UNCALIBRATED — a
// rationale, not a measurement, and explicitly the operator's to push back on.
//
// ★ BUT THREE NUMBERS ARE NOT SOMETHING ANYONE CAN PUSH BACK ON. "dwell 1200 ms" is not a thing you
// can have an opinion about; "your screen changed four times during that transition" is. So this
// replays a scripted set through the real reducer and prints the listener's screen as a TIMELINE —
// no session, no device, no UI. It is the prototype the thread asked for, in the only form
// available while the live run is blocked.
//
// It is a SIMULATION OF A HOST, stated plainly: the gesture patterns below are written from what
// mixing looks like, not recorded from a real set. No recorded intent stream exists in this repo —
// I looked. So the shapes are arguable and the point is that they are arguable IN FRONT OF THE
// OPERATOR rather than inside a constant.
import { DEFAULT_POLICY, focusOf, initialFocus, nextFocus, type Focus, type FocusPolicy, type FocusState } from "../../src/App/listenerFocus";
import type { Intent } from "../../src/htl/room/protocol";

type Ev = { at: number; i: Intent; note?: string };

const ctl = (deck: "A" | "B", param = "tempo"): Intent => ({ kind: "control", deck, param, value: 1 }) as Intent;
const fx = (deck: "A" | "B"): Intent => ({ kind: "fxParam", deck, slot: 0, param: "mix", value: 0.5 }) as Intent;
const xf = (): Intent => ({ kind: "crossfade", value: 0.5 }) as Intent;

/** A transition: the host rides both channels, reaches for FX, then settles on the incoming deck. */
function transition(t0: number): Ev[] {
  const out: Ev[] = [];
  let t = t0;
  out.push({ at: t, i: ctl("A"), note: "playing out of deck A" });
  for (let k = 0; k < 6; k++) out.push({ at: (t += 400), i: ctl("A") });
  out.push({ at: (t += 600), i: ctl("B"), note: "cues the incoming deck" });
  // The churn window: riding both channels, alternating, for ~8 seconds.
  for (let k = 0; k < 10; k++) out.push({ at: (t += 700), i: ctl(k % 2 ? "A" : "B") });
  out.push({ at: (t += 500), i: xf(), note: "crossfader — global, says nothing about attention" });
  for (let k = 0; k < 4; k++) out.push({ at: (t += 600), i: fx("B") });
  out.push({ at: (t += 400), i: fx("B"), note: "working the FX on the incoming deck" });
  for (let k = 0; k < 8; k++) out.push({ at: (t += 900), i: ctl("B") });
  out.push({ at: t, i: ctl("B"), note: "settled on deck B" });
  return out;
}

const label = (f: Focus | null) => (f ? (f.fx ? `DECK ${f.deck} +FX` : `DECK ${f.deck}`) : "—");
/** A SCREEN CHANGE is a deck swap or the FX layer opening/closing — the two are not the same size,
 *  and the whole point of the two-axis rule is that they stopped being charged as if they were. */
const differs = (a: Focus | null, b: Focus | null) => !!a && !!b && (a.deck !== b.deck || a.fx !== b.fx);

function run(events: Ev[], policy: FocusPolicy, name: string): { switches: number; longestHold: number } {
  console.log(`\n  ${name}   dwell ${policy.dwellMs} ms · cooldown ${policy.cooldownMs} ms · window ${policy.windowMs} ms · fx hold ${policy.fxHoldMs} ms\n`);
  let s: FocusState = initialFocus();
  let switches = 0;
  let lastChange = events[0].at;
  let longestHold = 0;
  for (const e of events) {
    const before = s.current;
    s = nextFocus(s, e.i, e.at, policy);
    const changed = differs(before, s.current);
    if (changed) {
      switches++;
      longestHold = Math.max(longestHold, e.at - lastChange);
      lastChange = e.at;
    }
    const host = focusOf(e.i);
    const secs = ((e.at - events[0].at) / 1000).toFixed(1).padStart(5);
    const mark = changed ? "  ⟵ SCREEN CHANGES" : "";
    if (changed || e.note) {
      console.log(`  ${secs}s  host: ${label(host).padEnd(8)}  listener sees: ${label(s.current).padEnd(8)}${mark}${e.note ? `   (${e.note})` : ""}`);
    }
  }
  longestHold = Math.max(longestHold, events[events.length - 1].at - lastChange);
  console.log(`\n  → ${switches} screen change${switches === 1 ? "" : "s"} across ${((events[events.length - 1].at - events[0].at) / 1000).toFixed(0)}s.`);
  return { switches, longestHold };
}

/** Literally "show what the host last touched" — the rule anyone writes first, and the one the
 *  hysteresis exists to prevent. Deliberately NOT the policy with its knobs zeroed. */
function runNaive(events: Ev[]): void {
  console.log(`\n  NAIVE — "follow the host", taken literally: show whatever deck or page they last touched\n`);
  let cur: Focus | null = null;
  let switches = 0;
  for (const e of events) {
    const f = focusOf(e.i);
    if (!f) continue;
    const changed = differs(cur, f);
    cur = f;
    if (changed) switches++;
    if (changed || e.note) {
      const secs = ((e.at - events[0].at) / 1000).toFixed(1).padStart(5);
      console.log(`  ${secs}s  host: ${label(f).padEnd(8)}  listener sees: ${label(cur).padEnd(8)}${changed ? "  ⟵ SCREEN CHANGES" : ""}${e.note ? `   (${e.note})` : ""}`);
    }
  }
  console.log(`\n  → ${switches} screen changes across ${((events[events.length - 1].at - events[0].at) / 1000).toFixed(0)}s.`);
}

const events = transition(0);
console.log("\n  FOLLOWLAB — one transition, replayed through the real follow rule (App/listenerFocus.ts).");
console.log("  Only the lines where the screen changes, or something notable happens, are shown.");

run(events, DEFAULT_POLICY, "SHIPPED POLICY");
// ★ THE NAIVE ARM HAS TO BE A DIFFERENT RULE, NOT THIS RULE WITH ZEROS. My first version ran the
// policy with dwell 0 and cooldown 0 and called it "no hysteresis". It is not: a THIRD mechanism —
// refusing to move while the current pane is still being touched — survives both zeros, so the
// zeroed arm showed 3 screen changes and looked like evidence that hysteresis barely matters. An
// arm that shares a suppression with the thing it is supposed to contrast is not a control.
// "Follow the host, literally" is last-touched-wins, so that is what it runs.
runNaive(events);
// A twitchier setting, for the operator to compare against.
run(events, { dwellMs: 600, cooldownMs: 1000, windowMs: 3000, fxHoldMs: 1500 }, "TWITCHIER");

// ★ THE SCENARIO THAT FOUND THE DEFECT, kept because the old one could not have found it. `transition`
// above reaches for FX in a CLEAN block with nothing interleaved, which is not what riding an effect
// looks like — a hand is on the fader at the same time. Under the old four-pane rule this produced 0
// screen changes across the whole ride: the listener never saw the FX at all, because every fader
// touch refreshed `deck:B` and blocked the `fx:B` candidate's dwell forever.
console.log("\n  ── RIDING AN EFFECT: fx and the fader, interleaved, on the same deck ──");
console.log("  The four-pane rule scored 0 screen changes here — the listener never saw the FX.");
{
  const e: Ev[] = [];
  let t = 0;
  for (let k = 0; k < 5; k++) e.push({ at: (t += 700), i: ctl("B") });
  e.push({ at: (t += 500), i: fx("B"), note: "reaches for the effect, fader still in the other hand" });
  for (let k = 0; k < 11; k++) e.push({ at: (t += 500), i: k % 2 ? ctl("B") : fx("B") });
  for (let k = 0; k < 6; k++) e.push({ at: (t += 700), i: ctl("B"), note: k === 5 ? "lets go of the effect" : undefined });
  run(e, DEFAULT_POLICY, "SHIPPED POLICY — riding an effect");
}

console.log("\n  The numbers in DEFAULT_POLICY are UNCALIBRATED — a rationale, not a measurement (ruling f103a5d0).");
console.log("  This exists so they can be argued with as behaviour rather than as constants.\n");
