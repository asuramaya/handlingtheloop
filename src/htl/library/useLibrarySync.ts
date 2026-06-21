// Cross-device library sync for signed-in accounts. The Collection + Playlists live in
// localStorage (single source of truth for the UI); when the user is signed in we mirror
// the blob to the server (D1) and reconcile on load. Conflict policy is last-write-wins by
// timestamp — the same contract as settingsSync, just a separate blob + clock. Audio is
// NOT synced here: R2 is a shared cache and anything missing re-resolves on demand, so only
// the curation (which tracks, which playlists, in order) has to travel between devices.
import { useEffect, useRef } from "react";
import { fetchMe } from "../account";
import type { Library, LibraryData } from "./useLibrary";

const LOCAL_TS_KEY = "htl:libraryUpdatedAt";
const PUSH_DEBOUNCE = 1000;
const POLL_MS = 45000; // lazy backstop — adopt a newer remote made while this device was idle

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

async function pullRemote(): Promise<{ data: LibraryData; updatedAt: number } | null> {
  try {
    const r = await fetch("/api/me/library", { credentials: "include" });
    if (!r.ok) return null;
    const j = (await r.json()) as { data: LibraryData | null; updatedAt: number };
    return j.data ? { data: j.data, updatedAt: j.updatedAt ?? 0 } : null;
  } catch {
    return null;
  }
}

function pushRemote(data: LibraryData, updatedAt: number) {
  void fetch("/api/me/library", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data, updatedAt }),
  }).catch(() => {});
}

/** Wire the library to the account: reconcile local vs remote once on sign-in, then
 *  debounce-push every later change; a slow poll adopts a newer remote from another device. */
export function useLibrarySync(library: Library) {
  const signedIn = useRef(false);
  const hydrated = useRef(false); // reconciled with the server at least once
  const lastSynced = useRef(""); // JSON of the last value pulled/pushed (skips the adopt bounce)
  const pushTimer = useRef<number | undefined>(undefined);
  // Keep the latest snapshot in a ref so the mount + poll effects (which run once) always
  // read the current library without re-subscribing.
  const snap = useRef<LibraryData>({ collection: library.collection, playlists: library.playlists });
  snap.current = { collection: library.collection, playlists: library.playlists };
  const replaceAll = library.replaceAll;

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
          stampLocal(remote.updatedAt);
          lastSynced.current = JSON.stringify(remote.data);
          replaceAll(remote.data);
        } else {
          const ts = localTs() || stampLocal();
          lastSynced.current = JSON.stringify(snap.current);
          pushRemote(snap.current, ts);
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

  // On every local change after hydration, stamp + debounce-push (skipping the no-op
  // change that adopting a remote value itself triggers).
  useEffect(() => {
    if (!signedIn.current || !hydrated.current) return;
    const json = JSON.stringify({ collection: library.collection, playlists: library.playlists });
    if (json === lastSynced.current) return;
    lastSynced.current = json;
    const ts = stampLocal();
    const data = { collection: library.collection, playlists: library.playlists };
    window.clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(() => pushRemote(data, ts), PUSH_DEBOUNCE);
  }, [library.collection, library.playlists]);

  // Poll backstop: adopt the server copy if it's newer (a change made on another device
  // while this one was idle). Stamps the shared clock + lastSynced so the push effect
  // doesn't bounce the adopted value straight back.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!signedIn.current || !hydrated.current) return;
      void pullRemote().then((remote) => {
        if (!remote || remote.updatedAt <= localTs()) return;
        const json = JSON.stringify(remote.data);
        stampLocal(remote.updatedAt);
        if (json === lastSynced.current) return; // newer stamp, identical value — nothing to apply
        lastSynced.current = json;
        replaceAll(remote.data);
      });
    }, POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
