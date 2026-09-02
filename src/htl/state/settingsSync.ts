// Cross-device settings sync for signed-in accounts. The Settings blob lives in
// localStorage (single source of truth for the UI); when the user is signed in we
// mirror it to the server (D1) and reconcile on load. Conflict policy is
// last-write-wins by timestamp: each local change stamps `htl:settingsUpdatedAt`,
// and on load whichever side (local vs remote) is newer wins.
import { useEffect, useRef } from "react";
import { fetchMe } from "../account";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

const LOCAL_TS_KEY = "htl:settingsUpdatedAt";
const PUSH_DEBOUNCE = 800;
const POLL_MS = 30000; // lazy backstop: the live account-room broadcast is the instant path, so the poll only needs to catch the rare missed nudge — 30 s keeps it cheap (was 5 s, which spammed /api/me/settings)

/** Last local settings-change timestamp (epoch ms). Exported so the live account-room
 *  broadcast path (App) can stay last-write-wins consistent with the durable D1 sync. */
export function localTs(): number {
  return Number(localStorage.getItem(LOCAL_TS_KEY) || 0);
}
/** Stamp the local settings-change time (shared LWW clock for both sync paths). */
export function stampLocal(ts = Date.now()): number {
  try {
    localStorage.setItem(LOCAL_TS_KEY, String(ts));
  } catch {
    /* ignore */
  }
  return ts;
}

async function pullRemote(): Promise<{ data: Partial<Settings>; updatedAt: number } | null> {
  try {
    const r = await fetch("/api/me/settings", { credentials: "include" });
    if (!r.ok) return null;
    const j = (await r.json()) as { data: Partial<Settings> | null; updatedAt: number };
    return j.data ? { data: j.data, updatedAt: j.updatedAt ?? 0 } : null;
  } catch {
    return null;
  }
}

// ★ THE PUSH REPORTS NOW. It was `void fetch(...).catch(() => {})` — every failure swallowed,
// including the one the server actually returns on purpose: 413, the 256 KB per-user cap. A user
// whose settings outgrow that cap simply stops syncing, on every device, with nothing anywhere to
// say so; the preset banks are the biggest thing in the blob and the most likely to cross it. A
// sync that can fail silently is a backup that can fail silently.
export interface SettingsSyncState {
  /** null until fetchMe() has answered — "unknown", not "signed out". */
  signedIn: boolean | null;
  lastPushAt: number;
  /** Human-readable reason the last push failed, or null. */
  error: string | null;
  /** Serialized size of the last blob we tried to store, in bytes. */
  bytes: number;
}
let syncState: SettingsSyncState = { signedIn: null, lastPushAt: 0, error: null, bytes: 0 };
const syncSubs = new Set<() => void>();
/** A STABLE reference between changes — useSyncExternalStore compares by identity. */
export function settingsSyncState(): SettingsSyncState {
  return syncState;
}
export function onSettingsSync(fn: () => void): () => void {
  syncSubs.add(fn);
  return () => syncSubs.delete(fn);
}
function setSyncState(patch: Partial<SettingsSyncState>) {
  const next = { ...syncState, ...patch };
  if (next.signedIn === syncState.signedIn && next.lastPushAt === syncState.lastPushAt && next.error === syncState.error && next.bytes === syncState.bytes) return;
  syncState = next;
  for (const fn of syncSubs) fn();
}

function pushRemote(data: Settings, updatedAt: number) {
  const body = JSON.stringify({ data, updatedAt });
  void fetch("/api/me/settings", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body,
  })
    .then(async (r) => {
      if (r.ok) return setSyncState({ lastPushAt: Date.now(), error: null, bytes: body.length });
      const why = r.status === 413 ? "too large to sync" : r.status === 401 ? "signed out" : `server said ${r.status}`;
      setSyncState({ error: why, bytes: body.length });
    })
    .catch(() => setSyncState({ error: "offline", bytes: body.length }));
}

// Wire the app's settings state to the account. Pulls + reconciles once the user is
// known to be signed in, then debounce-pushes every subsequent local change.
export function useSettingsSync(settings: Settings, setSettings: (s: Settings) => void) {
  const signedIn = useRef(false);
  const hydrated = useRef(false); // reconciled with the server at least once
  const lastSynced = useRef(""); // JSON of the last value we pulled/pushed (dedup)
  const pushTimer = useRef<number | undefined>(undefined);

  // On mount: identify the user and reconcile local vs remote by timestamp.
  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then(async (me) => {
        if (cancelled) return;
        setSyncState({ signedIn: !!me.user });
        if (!me.user) return; // signed out → purely local, no sync
        signedIn.current = true;
        const remote = await pullRemote();
        if (cancelled) return;
        if (remote && remote.updatedAt > localTs()) {
          // Remote is newer — adopt it (merged over defaults for forward-compat).
          stampLocal(remote.updatedAt);
          const merged = { ...DEFAULT_SETTINGS, ...remote.data };
          lastSynced.current = JSON.stringify(merged);
          setSettings(merged);
        } else {
          // Local is newer (or the account has nothing yet) — push local up.
          const ts = localTs() || stampLocal();
          lastSynced.current = JSON.stringify(settings);
          pushRemote(settings, ts);
        }
        hydrated.current = true;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      window.clearTimeout(pushTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On every local change after hydration, stamp + debounce-push (skipping the
  // no-op change that applying the remote value itself triggers).
  useEffect(() => {
    if (!signedIn.current || !hydrated.current) return;
    const json = JSON.stringify(settings);
    if (json === lastSynced.current) return;
    lastSynced.current = json;
    const ts = stampLocal();
    window.clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(() => pushRemote(settings, ts), PUSH_DEBOUNCE);
  }, [settings]);

  // Poll backstop for "instant change on all account devices": every few seconds re-pull and
  // adopt if the server copy is newer (timestamp LWW). This is the eventually-consistent net
  // under the instant account-room broadcast — it catches a change made while this device was
  // briefly disconnected from the room, or signed in without an open session. Adopting stamps
  // the shared clock + lastSynced so the push effect doesn't bounce the value straight back.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!signedIn.current || !hydrated.current) return;
      void pullRemote().then((remote) => {
        if (!remote || remote.updatedAt <= localTs()) return;
        stampLocal(remote.updatedAt);
        const merged = { ...DEFAULT_SETTINGS, ...remote.data };
        const json = JSON.stringify(merged);
        if (json === lastSynced.current) return; // newer stamp, identical value — clock adopted, nothing to apply
        lastSynced.current = json;
        setSettings(merged);
      });
    }, POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
