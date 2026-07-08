// PCM-byte accounting for the iOS 2-stem OOM hunt (#69/#70).
//
// iOS kills the WebContent process silently on OOM — no catchable JS error — so we can't just
// try/catch the crash. Instead we breadcrumb the COMPUTED resident + transient PCM bytes through
// stemTrace (a synchronous localStorage write that survives the process kill). After loading two
// long stem-separated tracks (crash or not), Settings ▸ Debug ▸ Diagnostics shows the peak overlap
// and — if it died — the last breadcrumb before the reload.
//
// The theory we're testing (docs/engine-stem-paging.md §1a): the crash is a LOAD TRANSIENT, not
// steady state. During deck 2's `loadEnginePcm` the deck momentarily holds its float32 stems
// (~460 MB) + the just-built int16 (~230 MB) + its float32 mix, ON TOP of deck 1's resident int16
// — briefly ~1 GB, past the ~1.5 GB WebKit page cliff. If the breadcrumb confirms that peak, the
// fix is the streaming-pack refactor (Phase 1, no pager). If it dies well below the computed peak,
// there's memory we're not accounting and the pager (Phase 2) is back on the table.
import { stemTrace } from "../stems/trace";

const resident = new Map<string, number>(); // meterId -> steady-state resident PCM bytes (int16 stems)
let peak = 0;

const mb = (b: number): string => (b / 1048576).toFixed(0) + "M";

/** Set a deck's steady-state resident PCM (the int16 stems handed to the worklet). */
export function pcmResident(id: string, bytes: number): void {
  resident.set(id, bytes);
}

function totalResident(): number {
  let s = 0;
  for (const b of resident.values()) s += b;
  return s;
}

/** Breadcrumb a transient: `inFlight` bytes (float32 stems being packed + the int16 + the mix)
 *  layered on TOP of every deck's steady-state resident. Tracks the running peak. Best-effort,
 *  survives an iOS tab-kill via stemTrace. */
export function pcmMark(label: string, inFlight = 0): void {
  const now = totalResident() + inFlight;
  if (now > peak) peak = now;
  stemTrace("pcm", `${label} peak=${mb(peak)} now=${mb(now)} (resident=${mb(totalResident())} +inflight=${mb(inFlight)})`);
}

/** Highest transient PCM total seen this session (bytes). */
export function pcmPeak(): number {
  return peak;
}
