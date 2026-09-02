import { describe, expect, it } from "vitest";
import { SCRATCH_WORKLET_SRC } from "./scratchWorklet";
import { STRETCH_WORKLET_SRC } from "./stretchWorklet";

// THE WORKLETS ARE STRINGS, AND A STRING DOES NOT TYPE-CHECK.
//
// Each processor is authored inside a template literal and loaded from a Blob URL, so tsc sees
// one long string and nothing inside it. A syntax error there fails at addModule() — asynchronously,
// inside an audio path, where it surfaces as "the deck makes no sound" rather than as a build error.
//
// One failure mode tsc DOES catch, worth knowing because it is not the one you would guess: an
// unescaped backtick anywhere in the source — including inside a comment, quoting an identifier the
// way this file's own prose does — ends the literal early. That happened while the scratch
// worklet's comments were being rewritten, and the error pointed at a line of English rather than
// at any code. (Escaped ones are fine and the stretch worklet has several.) What tsc CANNOT see is
// a genuine syntax error inside the string, which is what these check.
describe("worklet sources", () => {
  const sources: [string, string][] = [
    ["scratch", SCRATCH_WORKLET_SRC],
    ["stretch", STRETCH_WORKLET_SRC],
  ];

  for (const [name, src] of sources) {
    it(`${name}: parses as JavaScript`, () => {
      // Function() compiles without executing — AudioWorkletProcessor and registerProcessor do not
      // exist here, and are never called, so only the SYNTAX is under test.
      expect(() => new Function(src)).not.toThrow();
    });

    it(`${name}: registers its processor`, () => {
      expect(src).toMatch(/registerProcessor\(\s*['"][a-z]+['"]/);
    });

  }
});
