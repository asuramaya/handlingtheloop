// decode.ts — pure MIDI relative-encoder byte decoders. Hardware sends a 7-bit value (0..127)
// per tick; these turn one raw byte into a SIGNED step. Lifted out of MidiEngine so the
// off-by-one-prone wrap + two's-complement math is unit-testable in isolation (the engine is a
// stateful Web MIDI consumer). The two conventions look similar but decode DIFFERENTLY — mixing
// them up (decoding a two's-complement browse encoder as if it were centered) leapt the cursor
// ±63 rows per detent, the bug this split guards against. See decode.test.ts.

// Jog platter / pitch-bend ring / search / zoom: a relative tick CENTERED on 0x40 (64).
// 0x41 = +1, 0x3F = −1, |delta| = speed, sign = direction. Resting value is 64 → 0.
export function centeredDelta(val: number): number {
  return val - 64;
}

// Pioneer rotary BROWSE selector: a 2's-complement relative encoder, NOT centered on 0x40.
// 0x01..0x3F = +1..+63 (forward); 0x7F..0x41 = −1..−63 (back, 0x7F = −1). Resting value is 0.
export function twosComplementDelta(val: number): number {
  return val < 64 ? val : val - 128;
}

// Endless encoder reported as ABSOLUTE 0..127 that WRAPS (127→0): a plain (val−last) would read a
// wrap as a ∓127 full-range LEAP, so treat 0..127 as CIRCULAR and fold the step back into
// (−64, 64]. `last` undefined (first sample) → 0 — it only seeds the reference, never a jump.
export function wrappingStep(last: number | undefined, val: number): number {
  if (last == null) return 0;
  let raw = val - last;
  if (raw > 64) raw -= 128;
  else if (raw < -64) raw += 128;
  return raw;
}
