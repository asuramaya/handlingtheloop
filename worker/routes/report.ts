import { type Env, json, sessionUser } from "../shared";
import { allow, clientIp } from "../../server/security";

interface BugReportBody {
  id?: string;
  version?: string;
  platform?: unknown;
  description?: string;
  sections?: unknown;
  events?: unknown;
  stemTrace?: string;
  url?: string;
}

// Bug reports (Settings ▸ Debug → one click). Anonymous is allowed — a bug can hit a signed-out
// user; if signed in we stamp the account so it's traceable. ONE bounded row: every field is capped
// server-side (never trust client sizes), and it's per-IP rate-limited so the table can't be spammed.
// Read side is admin-only (the Access-gated admin worker), never exposed here.
export async function handleReportRoutes(url: URL, req: Request, env: Env): Promise<Response | null> {
  if (url.pathname !== "/api/bug-report") return null;
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!env.DB) return json(503, { error: "no store" });
  if (!(await allow(env.RL_WRITE, clientIp(req)))) return json(429, { error: "rate limited" });

  const b = (await req.json().catch(() => null)) as BugReportBody | null;
  if (!b || typeof b !== "object") return json(400, { error: "bad body" });
  const user = await sessionUser(req, env).catch(() => null);

  const cap = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "");
  const id = cap(b.id, 64) || crypto.randomUUID();
  const version = cap(b.version, 40) || "unknown";
  const platform = JSON.stringify(b.platform ?? {}).slice(0, 2000);
  const description = cap(b.description, 2000);
  const snapshot = JSON.stringify(b.sections ?? []).slice(0, 40000);
  const events = JSON.stringify(b.events ?? []).slice(0, 40000);
  const stemTrace = cap(b.stemTrace, 8000) || null;
  const routeUrl = cap(b.url, 300);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO bug_reports
       (id, created_at, account_id, version, platform, description, snapshot, events, stem_trace, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, Date.now(), user?.id ?? null, version, platform, description, snapshot, events, stemTrace, routeUrl)
    .run();

  return json(200, { ok: true, id });
}
