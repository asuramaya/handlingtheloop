import type { Verdict } from "./judge";

// Two scores, by design:
//  - Timing  = the honest rhythm-game number (did the peak land in the window).
//  - Style   = deliberately generous; rewards amplitude, flourishes, combo. This
//              is the number people screenshot. Rank is mostly Style-driven so
//              nearly everyone finishes feeling good — that's what makes it spread.

export type Rank = "Bedroom Legend" | "Resident DJ" | "Headliner";

const TIMING_POINTS: Record<Verdict, number> = {
  PERFECT: 100,
  GREAT: 70,
  GOOD: 40,
  MISS: 0,
};

export class ScoreModel {
  timing = 0;
  style = 0;
  combo = 0;
  maxCombo = 0;

  /**
   * @param amplitude raw peak velocity from the gesture (bigger move = more style)
   * @param flourish  whether the hit note was an optional flourish prompt
   */
  registerHit(verdict: Verdict, amplitude: number, flourish = false): void {
    this.timing += TIMING_POINTS[verdict];

    if (verdict === "MISS") {
      this.combo = 0;
      return;
    }
    this.combo += 1;
    this.maxCombo = Math.max(this.maxCombo, this.combo);

    // Style is generous: a flat base + an expressiveness bonus (capped so a flail
    // can't dominate) + a combo multiplier + a flourish kicker.
    const expressiveness = Math.min(amplitude, 6) * 8; // amplitude in rad/s-ish
    const comboMult = 1 + Math.min(this.combo, 20) * 0.1;
    const flourishBonus = flourish ? 120 : 0;
    this.style += Math.round((60 + expressiveness) * comboMult + flourishBonus);
  }

  registerMiss(): void {
    this.combo = 0;
  }

  get rank(): Rank {
    // Style-weighted, with a light Timing gate so it still reads as a real game.
    const s = this.style + this.timing * 0.5;
    if (s >= 2600) return "Headliner";
    if (s >= 1100) return "Resident DJ";
    return "Bedroom Legend";
  }
}
