// Waveshaper transfer curves for the FX ducking sidechain (envelope follower → wet gain).
// These were byte-identical copies in DelayFx.ts and ReverbFx.ts; one home now.

/** |x| rectifier for the ducking envelope follower. */
export function makeRectifyCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.abs((i / (n - 1)) * 2 - 1);
  return curve;
}

/**
 * Clamp the (boosted) envelope to [0,1] so the duck can't drive the wet gain negative —
 * inputs beyond ±1 hold the endpoint value (1), so it saturates instead of inverting.
 */
export function makeClampCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.max(0, Math.min(1, x));
  }
  return curve;
}
