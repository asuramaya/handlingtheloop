// SetCapture (Epic G1a) — the host-side recorder for a live broadcast. It tees the
// client's OUTBOUND recipe messages (the same stream a tuned-in listener reconstructs the
// mix from) into a timestamped log while the host is live. On broadcast-end the host POSTs
// the log; it lands in R2 and replays on-device (G1c) through the same engine handlers.
//
// Commands only — NO audio (the legal posture + why a recipe is tiny). We keep the
// recipe-relevant kinds and drop the rest: `stemview`/`lyrics` are display data the device
// regenerates from the track, control-plane handshakes (join/listen/grant…) aren't the mix,
// and 20 Hz `tick`s are a live drift anchor a recording doesn't need (its clock is local) —
// so ticks are downsampled to ~1/sec position anchors. Host-side capture is the v1 choice:
// the recipe is cheap and it dodges the DjRoom write-quota ceiling. Co-DJ intents that flow
// through the server but not this device aren't captured (solo host = full capture; G5).
import type { ClientMsg } from "./protocol";
import { ENGINE_VERSION } from "./protocol";

export interface CaptureEntry {
  t: number; // ms since capture start
  m: ClientMsg; // the recipe message (state / intent / automix / tick)
}

export interface TrackMark {
  videoId: string;
  title?: string;
  artist?: string;
  at: number; // ms since capture start
}

/** The serialized recipe a host POSTs on broadcast-end (→ R2 log + a D1 `sets` row). */
export interface CapturedSet {
  engineVersion: number;
  duration: number; // ms
  log: CaptureEntry[];
  tracklist: TrackMark[];
  coverVideo: string | null;
}

// Recipe-relevant outbound messages — the deterministic-rebuild stream. Everything else is
// excluded (see the file header for why).
const CAPTURED: ReadonlySet<ClientMsg["t"]> = new Set(["state", "intent", "automix", "tick"]);
const TICK_MIN_MS = 1000; // ≥1s between captured position ticks
const MAX_ENTRIES = 200_000; // safety cap (~hours of intents) so a runaway log can't OOM the tab

export class SetCapture {
  private active = false;
  private t0 = 0;
  private log: CaptureEntry[] = [];
  private marks: TrackMark[] = [];
  private lastTick = -Infinity;
  private cover: string | null = null;

  // The clock is injectable so tests drive it deterministically; live it's the monotonic
  // performance clock (immune to wall-clock jumps mid-set).
  constructor(private clock: () => number = SetCapture.defaultClock) {}
  private static defaultClock(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  get capturing(): boolean {
    return this.active;
  }

  /** Begin a fresh capture (host went live). */
  start(): void {
    this.active = true;
    this.t0 = this.clock();
    this.log = [];
    this.marks = [];
    this.lastTick = -Infinity;
    this.cover = null;
  }

  /** The tee: every outbound client message passes here. Cheap no-op when not capturing. */
  record(m: ClientMsg): void {
    if (!this.active || !CAPTURED.has(m.t)) return;
    const t = this.clock() - this.t0;
    if (m.t === "tick") {
      if (t - this.lastTick < TICK_MIN_MS) return; // downsample the 20 Hz clock
      this.lastTick = t;
    }
    if (this.log.length >= MAX_ENTRIES) return;
    this.log.push({ t, m });
  }

  /** The host's now-playing changed → a tracklist marker (deduped on consecutive videoId). */
  mark(track: { videoId: string; title?: string; artist?: string }): void {
    if (!this.active || !track.videoId) return;
    const last = this.marks[this.marks.length - 1];
    if (last && last.videoId === track.videoId) return;
    this.marks.push({ videoId: track.videoId, title: track.title, artist: track.artist, at: this.clock() - this.t0 });
    if (!this.cover) this.cover = track.videoId; // first track = the card thumbnail
  }

  /** Stop + return the captured recipe, or null if nothing worth keeping. Idempotent —
   *  a second call (close() racing goPublic(false)) returns null. */
  stop(): CapturedSet | null {
    if (!this.active) return null;
    this.active = false;
    const duration = this.clock() - this.t0;
    const log = this.log;
    const tracklist = this.marks;
    const coverVideo = this.cover;
    this.log = [];
    this.marks = [];
    this.cover = null;
    // A momentary go-live → -off with no real activity isn't a set; don't persist an empty.
    if (log.length === 0 && tracklist.length === 0) return null;
    return { engineVersion: ENGINE_VERSION, duration, log, tracklist, coverVideo };
  }
}
