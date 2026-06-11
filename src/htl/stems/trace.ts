// Crash breadcrumbs for on-device stem separation.
//
// Debugging an iPhone-Safari crash is hard: there's no readable console without a
// Mac + Web Inspector, and an OOM jetsam-kill of the tab leaves NO catchable JS
// error (the whole WebContent process dies). The one thing that survives is a
// SYNCHRONOUS localStorage write — it's flushed before the process is killed. So we
// drop a breadcrumb at every step of the heavy path; after the tab reloads we read
// the trace and the LAST entry is exactly where it died (which window, the assembly,
// the resample…). Surfaced in Settings ▸ Stems ▸ Diagnostics so it's readable on the
// device itself, no Mac required.
const KEY = "htl:stemTrace";
const MAX = 80;

export interface StemTraceEntry {
  t: number; // epoch ms
  step: string;
  info?: string;
}

export function stemTrace(step: string, info?: string): void {
  try {
    const arr: StemTraceEntry[] = JSON.parse(localStorage.getItem(KEY) || "[]");
    arr.push({ t: Date.now(), step, info });
    while (arr.length > MAX) arr.shift();
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {
    /* private mode / quota — diagnostics are best-effort */
  }
}

export function readStemTrace(): StemTraceEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function clearStemTrace(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// Pretty one-liner per entry, e.g. "+1.8s  win 3/8:run  start=5.95M". The first
// column is seconds since the trace's first entry, so the gaps reveal the slow/dying
// step even when the final crash entry has no "done" after it.
export function formatStemTrace(entries: StemTraceEntry[]): string {
  if (!entries.length) return "(no separation runs recorded yet)";
  const t0 = entries[0].t;
  return entries
    .map((e) => `+${((e.t - t0) / 1000).toFixed(1)}s  ${e.step}${e.info ? `  ${e.info}` : ""}`)
    .join("\n");
}
