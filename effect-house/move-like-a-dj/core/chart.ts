import type { GestureType } from "./gesture";

// A chart is music-agnostic: a list of notes on beat indices of the GAME clock,
// NOT of any specific song (we can't author to a song the user hasn't picked and
// that TikTok swaps on upload). beatIndex is multiplied by the clock's beatPeriod
// at runtime to get a target time.

export interface Note {
  beatIndex: number;
  type: GestureType;
  /** optional flourish prompt — hitting it pays Style, missing it costs nothing */
  flourish?: boolean;
}

// v1 vertical slice: head-bop on every downbeat for 8 bars (4/4), a couple of
// optional flourishes. Crossfader notes are stubbed in for when the hand lane lands.
export const DEMO_CHART: Note[] = [
  { beatIndex: 4, type: "headBop" },
  { beatIndex: 8, type: "headBop" },
  { beatIndex: 12, type: "headBop", flourish: true },
  { beatIndex: 16, type: "headBop" },
  { beatIndex: 20, type: "headBop" },
  { beatIndex: 24, type: "headBop" },
  { beatIndex: 28, type: "headBop", flourish: true },
  { beatIndex: 32, type: "headBop" },
];
