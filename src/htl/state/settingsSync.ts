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

function localTs(): number {
  return Number(localStorage.getItem(LOCAL_TS_KEY) || 0);
}
function stampLocal(ts = Date.now()): number {
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

function pushRemote(data: Settings, updatedAt: number) {
  void fetch("/api/me/settings", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data, updatedAt }),
  }).catch(() => {});
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
        if (cancelled || !me.user) return; // signed out → purely local, no sync
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
}
