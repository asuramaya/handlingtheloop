import { describe, it, expect } from "vitest";
import { randomTheme, randomMono, hueGap, contrastRatio, spreadHues, hslToHex, deckShades, hueSatOf } from "./randomPalette";

// A generator is only as good as its WORST roll, so these run it many times and assert the
// invariant held every single time. One bad theme in fifty is a bad generator: the user does not
// experience the average, they experience the roll they got.
const ROLLS = 400;
const hueOf = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return -1;
  const d = mx - mn;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
};
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b;
};
const worst = (f: () => number) => {
  let w = Infinity;
  for (let i = 0; i < ROLLS; i++) w = Math.min(w, f());
  return w;
};

describe("spreadHues", () => {
  it("never lets two hues close to within half a step, however it jitters", () => {
    for (let i = 0; i < ROLLS; i++) {
      for (const n of [2, 3, 4]) {
        const hs = spreadHues(n, Math.random() * 360);
        for (let a = 0; a < n; a++) {
          for (let b = a + 1; b < n; b++) {
            expect(hueGap(hs[a], hs[b])).toBeGreaterThan((360 / n) * 0.3);
          }
        }
      }
    }
  });
});

describe("randomTheme", () => {
  it("always gives the two decks clearly different colours", () => {
    // The old generator drew every hue independently, so two decks landing on the same colour was
    // just something that happened. Decks are the thing you must never misread.
    expect(worst(() => {
      const t = randomTheme();
      return hueGap(hueOf(t.accentA), hueOf(t.accentB));
    })).toBeGreaterThan(90);
  });

  it("always keeps the four stem lanes apart from each other", () => {
    expect(worst(() => {
      const t = randomTheme();
      const hs = [t.stemDrumsColor, t.stemBassColor, t.stemVocalsColor, t.stemOtherColor].map(hueOf);
      let m = Infinity;
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) m = Math.min(m, hueGap(hs[a], hs[b]));
      return m;
    })).toBeGreaterThan(25);
  });

  it("always keeps the three band hues apart", () => {
    expect(worst(() => {
      const t = randomTheme();
      const hs = [t.freqLowColor, t.freqMidColor, t.freqHighColor].map(hueOf);
      let m = Infinity;
      for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) m = Math.min(m, hueGap(hs[a], hs[b]));
      return m;
    })).toBeGreaterThan(35);
  });

  it("always orders the bands dark to bright, which is what the layered wave reads as depth", () => {
    for (let i = 0; i < ROLLS; i++) {
      const t = randomTheme();
      expect(lum(t.freqLowColor)).toBeLessThan(lum(t.freqMidColor));
      expect(lum(t.freqMidColor)).toBeLessThan(lum(t.freqHighColor));
    }
  });

  it("always keeps text readable on the background", () => {
    // A theme you cannot read is not a fun roll, it is a broken app until you undo it.
    expect(worst(() => {
      const t = randomTheme();
      return contrastRatio(t.textColor, t.bgColor);
    })).toBeGreaterThan(7);
  });

  it("always keeps both deck accents visible against the background", () => {
    expect(worst(() => {
      const t = randomTheme();
      return Math.min(contrastRatio(t.accentA, t.bgColor), contrastRatio(t.accentB, t.bgColor));
    })).toBeGreaterThan(3);
  });

  it("emits a valid 6-digit hex for every field", () => {
    for (let i = 0; i < 50; i++) {
      for (const v of Object.values(randomTheme())) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("randomMono", () => {
  it("really is monochrome: one hue for every coloured field", () => {
    // The old "Mono" rolled an independent random hue per accent over a grey base, which is a
    // random theme with the colour turned up, not a monochrome one.
    for (let i = 0; i < ROLLS; i++) {
      const m = randomMono();
      const hues = [m.accentA, m.accentB, m.loopColor, m.shiftColor, m.stripColor,
        m.stemDrumsColor, m.stemBassColor, m.stemVocalsColor, m.stemOtherColor,
        m.freqLowColor, m.freqMidColor, m.freqHighColor].map(hueOf).filter((h) => h >= 0);
      for (const h of hues) expect(hueGap(h, hues[0])).toBeLessThan(6);
    }
  });

  it("separates the stem lanes by lightness instead, since hue is spoken for", () => {
    for (let i = 0; i < ROLLS; i++) {
      const m = randomMono();
      const ls = [m.stemDrumsColor, m.stemBassColor, m.stemVocalsColor, m.stemOtherColor].map(lum);
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) expect(Math.abs(ls[a] - ls[b])).toBeGreaterThan(12);
    }
  });

  it("keeps a pure black or white ground, and readable text on it", () => {
    for (let i = 0; i < ROLLS; i++) {
      const m = randomMono();
      expect(["#000000", "#ffffff"]).toContain(m.bgColor);
      expect(contrastRatio(m.textColor, m.bgColor)).toBeGreaterThan(15);
    }
  });

  it("still orders its bands dark to bright", () => {
    for (let i = 0; i < ROLLS; i++) {
      const m = randomMono();
      expect(lum(m.freqLowColor)).toBeLessThan(lum(m.freqMidColor));
      expect(lum(m.freqMidColor)).toBeLessThan(lum(m.freqHighColor));
    }
  });
});

describe("hslToHex", () => {
  it("round-trips the primaries", () => {
    expect(hslToHex(0, 100, 50)).toBe("#ff0000");
    expect(hslToHex(120, 100, 50)).toBe("#00ff00");
    expect(hslToHex(240, 100, 50)).toBe("#0000ff");
    expect(hslToHex(0, 0, 100)).toBe("#ffffff");
  });
});

describe("deckShades — stem lanes that follow their deck", () => {
  const DECKS = ["#a934fd", "#5f82eb", "#ff5d73", "#2ecc71", "#f1c40f", "#888888"];

  it("keeps every shade on the deck's own hue", () => {
    // The whole point: hue answers "which deck am I looking at". If it drifts, the feature has
    // nothing left to say.
    for (const d of DECKS) {
      const base = hueSatOf(d);
      if (base.sat < 8) continue; // a grey deck has no hue to hold
      for (const sh of deckShades(d)) {
        const g = hueGap(hueSatOf(sh).hue, base.hue);
        expect(g).toBeLessThan(4);
      }
    }
  });

  it("separates the four lanes by brightness, since hue is spoken for", () => {
    for (const d of DECKS) {
      const ls = deckShades(d).map(lum);
      for (let i = 1; i < ls.length; i++) expect(ls[i] - ls[i - 1]).toBeGreaterThan(25);
    }
  });

  it("keeps the darkest lane visible and the brightest off the rail", () => {
    for (const d of DECKS) {
      const ls = deckShades(d).map(lum);
      expect(ls[0]).toBeGreaterThan(45);
      expect(ls[ls.length - 1]).toBeLessThan(235);
    }
  });

  it("works for a fully desaturated deck colour instead of dividing by zero", () => {
    const ls = deckShades("#808080").map(lum);
    for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeGreaterThan(ls[i - 1]);
  });

  it("emits valid hex for any n", () => {
    for (const n of [2, 3, 4, 5]) {
      for (const v of deckShades("#a934fd", n)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
