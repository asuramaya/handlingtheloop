// Structured trace + flight recorder. Two sinks off one call:
//
//  • DEV FILE — in `pnpm dev` (import.meta.env.DEV) events are batched and POSTed as JSON lines to
//    the Vite middleware (/__htl_debug → .htl-debug.log), so a live session's behaviour can be read
//    straight off disk. Compiled to a no-op in prod (DEV statically false → tree-shaken). Off-switch:
//    localStorage['htl:trace']='0'.
//  • RING (prod too) — a bounded in-memory flight recorder of SIGNIFICANT events (`event()`), always
//    on, ~zero cost. It's what a one-click bug report dumps: the "how did we get here" without
//    streaming anything to a server. High-frequency `trace()` (per-fader-move) does NOT enter the
//    ring — only `event()` — so the ring stays small and relevant.
const DEV = Boolean(import.meta.env?.DEV);

let buf: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let enabled = DEV && !(typeof localStorage !== "undefined" && localStorage.getItem("htl:trace") === "0");

/** Turn the dev-file stream on/off at runtime (still a no-op unless this is a dev build). */
export function setTrace(on: boolean): void {
  enabled = on && DEV;
}

/** Fine-grained probe → dev file only. Cheap, fire-and-forget, never throws into the caller. Use for
 *  high-frequency signals (per-fader-move, per-tick) you only want while actively debugging in dev. */
export function trace(ch: string, data: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    buf.push(JSON.stringify({ t: Math.round(performance.now()), ch, ...data }));
  } catch {
    return; // unserialisable payload — drop it rather than disturb the audio path
  }
  if (buf.length >= 64) flush();
  else if (timer == null) timer = setTimeout(flush, 200);
}

function flush(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buf.length) return;
  const body = buf.join("\n");
  buf = [];
  void fetch("/__htl_debug", { method: "POST", body, keepalive: true }).catch(() => {});
}

// ── flight recorder ──────────────────────────────────────────────────────────────────────────────
const RING_CAP = 300; // last N significant events kept for a bug report (bounded → cheap in prod)
const ring: Array<Record<string, unknown>> = [];

/** Significant event → the flight-recorder ring (always, prod included) AND the dev file. This is the
 *  fuel for one-click bug reports: track loads, transitions, sync toggles, errors — the state changes
 *  you'd want to see leading up to a problem. Keep it to notable moments, not per-frame chatter. */
export function event(ch: string, data: Record<string, unknown>): void {
  try {
    ring.push({ t: Math.round(performance.now()), ch, ...data });
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  } catch {
    /* ignore — recording must never break the app */
  }
  trace(ch, data); // also stream to the dev file when DEV
}

/** Snapshot the flight-recorder ring (a shallow copy) — dumped into a bug report, and shown
 *  live in Settings ▸ Debug. It was invisible for a long time: the ring existed, recorded
 *  faithfully, and could only be read by SENDING a bug report and asking someone to look at the
 *  other end. On a phone, where there is no console, that made the most useful thing in the app
 *  the least reachable. */
export function dumpRing(): Array<Record<string, unknown>> {
  return ring.slice();
}

/** Empty the ring — so you can clear the decks, reproduce a bug, and read only what it did. */
export function clearRing(): void {
  ring.length = 0;
}

/** One event → a single readable line, shared by the on-screen recorder and the clipboard dump
 *  so what you copy is exactly what you were looking at. */
export function formatEvent(e: Record<string, unknown>): string {
  const { t, ch, ...rest } = e;
  const ms = typeof t === "number" ? t : 0;
  const stamp = `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  const body = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${stamp}  ${String(ch)}${body ? `  ${body}` : ""}`;
}

// Auto-capture uncaught errors + rejections into the ring the moment this module loads (it's imported
// early by the audio engine), so a report always carries whatever just blew up — the single highest
// value-per-byte payload after the user's own words. Guarded for non-browser (test/SSR) contexts.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("error", (e) => event("error", { msg: String(e.message ?? "").slice(0, 300), src: e.filename ?? "", line: e.lineno ?? 0 }));
  window.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    event("reject", { reason: String(r instanceof Error ? r.message : r).slice(0, 300) });
  });
  // ★ AND THE ONES THE APP REPORTS ABOUT ITSELF. The two listeners above only see what nobody
  // caught. Every failure this codebase HANDLES — a stem fetch that fell back to the mix, a
  // YouTube client retry, a WebGPU adapter that never arrived — is a `console.warn` inside a
  // catch, which means it was invisible to the flight recorder and therefore to every bug
  // report: the ring recorded a clean run right up to a problem the app had already diagnosed
  // in a string. A caught error is usually the MORE informative one, because the code that
  // caught it knew what it was doing at the time.
  //
  // The wrapper calls through first and can never throw into the caller: a debug facility that
  // can break logging is worse than no debug facility.
  for (const level of ["error", "warn"] as const) {
    const orig = console[level]?.bind(console);
    if (!orig) continue;
    console[level] = (...args: unknown[]) => {
      orig(...args);
      try {
        const msg = args
          .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : safeJson(a)))
          .join(" ")
          .slice(0, 300);
        if (msg) event(`console.${level}`, { msg });
      } catch {
        /* never let recording break a log call */
      }
    };
  }
}

// Stringify a console argument without throwing on a cycle or a huge object.
function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s == null ? String(v) : s.slice(0, 300);
  } catch {
    return String(v);
  }
}
