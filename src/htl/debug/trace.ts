// Dev-only structured trace sink. In `pnpm dev` (import.meta.env.DEV) it batches events and
// POSTs them as JSON lines to the Vite middleware (/__htl_debug → .htl-debug.log at the repo
// root), so the exact behaviour of the audio / tempo / queue engine during a LIVE session can
// be read back off disk — no console scraping, no guessing. Compiled to a no-op in the prod
// build (DEV is statically false → the calls tree-shake away). Runtime off-switch:
// localStorage['htl:trace'] = '0'.
const DEV = Boolean(import.meta.env?.DEV);

let buf: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let enabled = DEV && !(typeof localStorage !== "undefined" && localStorage.getItem("htl:trace") === "0");

/** Turn tracing on/off at runtime (still a no-op unless this is a dev build). */
export function setTrace(on: boolean): void {
  enabled = on && DEV;
}

/** Record one event on `ch` (a dotted channel like "sf" / "sync.match"). Cheap + fire-and-forget:
 *  events are stamped with a ms clock, buffered, and flushed on a short timer or when the buffer
 *  fills. Never throws into the caller. */
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
