// THE CROSSFADER CURVE, in one place. Equal power: position −1 = all A, 0 = both at −3 dB
// (cos π/4 ≈ 0.707), +1 = all B. AudioEngine.setCrossfade drives the gain nodes with it, and the
// AutoMixer reads it to know how much the fader is already taking off each deck — a second copy of
// the formula would be one more thing to drift (see AutoMixer: stem swaps compensate for it).
export function crossfadeGains(position: number): { A: number; B: number } {
  const x = (Math.max(-1, Math.min(1, position)) + 1) / 2; // -> [0,1]
  return { A: Math.cos((x * Math.PI) / 2), B: Math.cos(((1 - x) * Math.PI) / 2) };
}
