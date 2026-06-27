// Effect House component — the thin I/O edge that binds the pure core to APJS.
//
// Everything game-shaped (clock, gesture peak-detection, judging, scoring) lives
// in ../core and is unit-tested in Node. This file only: reads tracking from
// AlgorithmManager, moves the note sprites, and writes the HUD text. Attach it to
// a root scene object via Inspector > Add Component.
//
// API surface used here is from the documented APJS reference (2025-2026):
//   APJS.BasicScriptComponent, @component, @serializeProperty,
//   onStart/onUpdate(deltaTime), AlgorithmManager.getResult().getFaceBaseInfo(i).pitch,
//   SceneObject.getComponent("Text"|"ScreenTransform"), Text.text,
//   ScreenTransform.anchoredPosition, SceneObject.enabled.
// Items flagged VERIFY are documented-uncertain — confirm against in-editor
// IntelliSense before trusting (see ../ASSEMBLY.md "Verify in-editor").

import { GameClock } from "../core/clock";
import { DEMO_CHART } from "../core/chart";
import { PeakDetector } from "../core/gesture";
import { Judge, scheduleChart, type ScheduledNote } from "../core/judge";
import { ScoreModel } from "../core/score";

const LEAD_TIME = 1.5; // seconds a note is visible before the judgment bar
const LANE_TOP_PX = 520; // anchoredPosition.y where a note spawns
const LANE_BAR_PX = -360; // y of the judgment bar (where progress = 1)

@component()
export class MoveLikeADJ extends APJS.BasicScriptComponent {
  // --- Inspector wiring (assign these in the editor) ---
  @serializeProperty()
  scoreTextObject!: APJS.SceneObject;
  @serializeProperty()
  comboTextObject!: APJS.SceneObject;
  // Pre-placed pool of Screen Image notes we recycle (move + toggle visibility).
  // VERIFY: array @serializeProperty support — if not, expose N single slots.
  @serializeProperty()
  noteObjects!: APJS.SceneObject[];
  @serializeProperty()
  startBpm = 120;

  // --- runtime state ---
  private clock = new GameClock(120, 1.0); // 1s lead-in before beat 0
  private scheduled: ScheduledNote[] = [];
  private judge!: Judge;
  private score = new ScoreModel();
  private scoreText: APJS.Text | null = null;
  private comboText: APJS.Text | null = null;

  // Head bop = downward velocity peak on face pitch. The strongest signal we have:
  // pitch is read straight off the face tracker, no graph bridge.
  private headBop = new PeakDetector("headBop", {
    lowPass: 0.4,
    direction: -1, // pitch drops as the head nods down (VERIFY sign on device)
    velThresh: 1.2, // rad/s — tune on device
    refractory: 0.25,
    latency: -0.08, // LATENCY_OFFSET — tune on device, err generous
  });

  onStart(): void {
    this.clock.bpm = this.startBpm;
    this.scheduled = scheduleChart(DEMO_CHART, this.clock);
    this.judge = new Judge(this.scheduled);
    this.scoreText = this.scoreTextObject.getComponent("Text") as APJS.Text;
    this.comboText = this.comboTextObject.getComponent("Text") as APJS.Text;
    this.renderHud();
  }

  onUpdate(deltaTime: number): void {
    this.clock.advance(deltaTime);
    const t = this.clock.time;

    // 1) read tracking and fire a gesture event on a head-bop peak
    const result = APJS.AlgorithmManager.getResult();
    if (result.getFaceCount() > 0) {
      const pitch = result.getFaceBaseInfo(0).pitch;
      const ev = this.headBop.feed(pitch, t, deltaTime);
      if (ev) {
        const hit = this.judge.resolve(ev);
        if (hit) {
          this.score.registerHit(hit.verdict, ev.amplitude, hit.note.flourish);
          this.renderHud();
        }
      }
    }

    // 2) close out any notes whose window has passed
    const missed = this.judge.reap(t);
    if (missed.length) {
      for (const _ of missed) this.score.registerMiss();
      this.renderHud();
    }

    // 3) position the note sprites along the lane
    this.layoutNotes(t);
  }

  private layoutNotes(t: number): void {
    const pool = this.noteObjects ?? [];
    let slot = 0;
    for (const note of this.scheduled) {
      if (note.judged) continue;
      const progress = 1 - (note.targetTime - t) / LEAD_TIME; // 0 spawn .. 1 bar
      if (progress < 0 || slot >= pool.length) continue;
      const obj = pool[slot++];
      obj.enabled = true;
      const st = obj.getComponent("ScreenTransform") as APJS.ScreenTransform;
      const y = LANE_TOP_PX + (LANE_BAR_PX - LANE_TOP_PX) * progress;
      st.anchoredPosition = new APJS.Vector2f(0, y);
    }
    // hide unused pool slots
    for (let i = slot; i < pool.length; i++) pool[i].enabled = false;
  }

  private renderHud(): void {
    if (this.scoreText) this.scoreText.text = `STYLE ${this.score.style}`;
    if (this.comboText) {
      this.comboText.text = this.score.combo > 1 ? `x${this.score.combo}` : "";
    }
  }
}
