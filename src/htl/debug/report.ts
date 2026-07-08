// One-click bug report packer. Freezes the flight recorder: the user's words + the build SHA + the
// engine/session/device snapshot (Settings ▸ Debug already assembles this) + the event ring + the
// stem-separation breadcrumbs → one bounded JSON payload → POST /api/bug-report → one D1 row.
//
// Conservative by construction: user-triggered (never a background stream), everything capped, no
// PCM / no PII beyond the account the request already carries. Ranked by diagnostic value-per-byte —
// version + the user's sentence + snapshot + recent events + errors — and nothing else.
import { dumpRing } from "./trace";

// Injected at build time by Vite (see vite.config.ts `define`). Absent in tests → "dev".
declare const __HTL_BUILD__: string;

/** The Settings-debug section shape (title + key/value rows). Matches App's DebugSection so the
 *  existing `debug()` collector can be passed straight through without a transform. */
export interface ReportSection {
  title: string;
  rows: Array<[string, string]>;
}

export interface BugReportInput {
  description: string;
  sections: ReportSection[];
  stemTrace?: string | null;
}

export interface BugReportResult {
  ok: boolean;
  id?: string;
  error?: string;
}

function buildSha(): string {
  try {
    return typeof __HTL_BUILD__ === "string" ? __HTL_BUILD__ : "dev";
  } catch {
    return "dev";
  }
}

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `r_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Platform facts — a few hundred bytes, the highest value-per-byte after the build SHA: which
// environment the bug happened in. No fingerprinting beyond what a normal request already exposes.
function gatherPlatform(): Record<string, unknown> {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const scr = typeof screen !== "undefined" ? screen : undefined;
  return {
    ua: nav?.userAgent ?? "",
    lang: nav?.language ?? "",
    mobile: /Mobi|Android|iPhone|iPad/.test(nav?.userAgent ?? ""),
    screen: scr ? `${scr.width}x${scr.height}` : "",
    dpr: typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1,
    online: nav?.onLine ?? null,
  };
}

/** Pack + submit a bug report. Everything is capped before it leaves the device. Returns a small
 *  result the UI can flash — never throws. */
export async function submitBugReport(input: BugReportInput): Promise<BugReportResult> {
  const report = {
    id: newId(),
    createdAt: Date.now(),
    version: buildSha(),
    platform: gatherPlatform(),
    description: (input.description ?? "").slice(0, 2000),
    sections: input.sections ?? [],
    stemTrace: (input.stemTrace ?? "").slice(0, 8000) || null,
    events: dumpRing(), // the flight recorder — already bounded to the last N events
    url: typeof location !== "undefined" ? location.pathname + location.search : "",
  };
  try {
    const res = await fetch("/api/bug-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: j.id ?? report.id };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
