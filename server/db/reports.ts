// Moderation reports (L2). Users file them from the app; the admin worker reads the open
// queue and resolves them. Shares htl-db; the runtime ensure keeps local/older DBs in step.
import { type D1Database, now } from "./core";

export interface Report {
  id: number;
  kind: string;
  room: string | null;
  target_dev: string | null;
  target_text: string | null;
  target_user: string | null; // the reported ACCOUNT id (0021) — first-class, not free-text
  reporter: string;
  reason: string | null;
  ts: number;
  resolved: number;
  resolved_by: string | null;
  resolved_at: number | null;
}

export async function ensureReportsTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, room TEXT, target_dev TEXT, target_text TEXT, reporter TEXT NOT NULL, reason TEXT, ts INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, resolved_by TEXT, resolved_at INTEGER)",
    )
    .run();
  try {
    await db.prepare("ALTER TABLE reports ADD COLUMN target_user TEXT").run(); // 0021 — older DBs
  } catch {
    /* column already exists */
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_reports_open ON reports (resolved, ts)").run();
}

/** How many reports this reporter has filed since `sinceMs` — the anti-flood gate. */
export async function recentReportCount(db: D1Database, reporter: string, sinceMs: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND ts > ?").bind(reporter, sinceMs).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

export async function fileReport(
  db: D1Database,
  r: { kind: string; room: string | null; targetDev: string | null; targetText: string | null; targetUser?: string | null; reporter: string; reason: string | null },
): Promise<void> {
  await db
    .prepare("INSERT INTO reports (kind, room, target_dev, target_text, target_user, reporter, reason, ts) VALUES (?,?,?,?,?,?,?,?)")
    .bind(r.kind, r.room, r.targetDev, r.targetText, r.targetUser ?? null, r.reporter, r.reason, now())
    .run();
}

/** The moderation queue, newest first. Open-only by default; `all` includes resolved. */
export async function listReports(db: D1Database, all = false, limit = 200): Promise<Report[]> {
  const sql = all
    ? "SELECT * FROM reports ORDER BY ts DESC LIMIT ?"
    : "SELECT * FROM reports WHERE resolved = 0 ORDER BY ts DESC LIMIT ?";
  const r = await db.prepare(sql).bind(Math.max(1, Math.min(limit, 500))).all<Report>();
  return r.results ?? [];
}

export async function resolveReport(db: D1Database, id: number, by: string): Promise<void> {
  await db.prepare("UPDATE reports SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE id = ?").bind(by, now(), id).run();
}
