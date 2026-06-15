import { useMemo, useState } from "react";
import type { Library, TrackMeta } from "@htl";
import { fetchPlaylist, type MyPlaylist } from "@htl/media";
import {
  startGoogleSignIn,
  startSpotifyConnect,
  startTidalConnect,
  syncReadSource,
  syncMatch,
  type Candidate,
  type MatchRow,
  type Me,
  type ServicePlaylist,
} from "@htl/account";

// Guided onboarding/import: connect a service → pick playlists → auto-match all and
// import → review ONLY the low-confidence matches. Reuses the sync pipeline
// (syncReadSource → syncMatch). Auto-launches on first sign-in; also openable manually.

type Step = "connect" | "pick" | "importing" | "review" | "done";
type Service = "youtube" | "spotify" | "tidal";

interface Pickable {
  service: Service;
  id: string;
  title: string;
  count: number;
}
interface Flagged {
  playlistId: string;
  playlistName: string;
  row: MatchRow;
  choice: string; // selected candidate id, or "skip"
}

interface Props {
  me: Me | null;
  library: Library;
  ytPlaylists: MyPlaylist[];
  spotifyPlaylists: ServicePlaylist[];
  tidalPlaylists: ServicePlaylist[];
  onClose: () => void;
  embedded?: boolean; // render inline in the library content area, not as a full-screen modal
}

const SVC_LABEL: Record<Service, string> = { youtube: "YouTube", spotify: "Spotify", tidal: "TIDAL" };
const candidateToTrack = (c: Candidate): TrackMeta => ({
  videoId: c.id,
  title: c.title,
  artist: c.artist,
  duration: c.duration,
  thumbnail: c.thumbnail,
  views: null,
});

export function SetupWizard({ me, library, ytPlaylists, spotifyPlaylists, tidalPlaylists, onClose, embedded = false }: Props) {
  const connections = me?.connections ?? [];
  const connected = (s: Service) => connections.includes(s === "youtube" ? "google" : s);
  const anyConnected = connected("youtube") || connected("spotify") || connected("tidal");

  const [step, setStep] = useState<Step>(anyConnected ? "pick" : "connect");
  const [selected, setSelected] = useState<Set<string>>(new Set()); // "service:id"
  const [progress, setProgress] = useState("");
  const [flagged, setFlagged] = useState<Flagged[]>([]);
  const [summary, setSummary] = useState({ imported: 0, tracks: 0 });

  const pickables = useMemo<Pickable[]>(() => {
    const out: Pickable[] = [];
    if (connected("youtube")) for (const p of ytPlaylists) out.push({ service: "youtube", id: p.id, title: p.title, count: p.count });
    if (connected("spotify")) for (const p of spotifyPlaylists) out.push({ service: "spotify", id: p.id, title: p.title, count: p.count });
    if (connected("tidal")) for (const p of tidalPlaylists) out.push({ service: "tidal", id: p.id, title: p.title, count: p.count });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, ytPlaylists, spotifyPlaylists, tidalPlaylists]);

  const key = (p: Pickable) => `${p.service}:${p.id}`;
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const ensureLocalPlaylist = (p: Pickable): string => {
    const existing = library.playlists.find((pl) => pl.sourceListId === p.id);
    if (existing) return existing.id;
    return library.createPlaylist(p.title, p.id, p.service);
  };

  async function runImport() {
    const chosen = pickables.filter((p) => selected.has(key(p)));
    if (!chosen.length) return;
    setStep("importing");
    const flags: Flagged[] = [];
    let imported = 0;
    let trackCount = 0;
    for (const p of chosen) {
      setProgress(`Importing “${p.title}” (${SVC_LABEL[p.service]})…`);
      const plId = ensureLocalPlaylist(p);
      try {
        if (p.service === "youtube") {
          const { tracks } = await fetchPlaylist(p.id); // exact videoIds — all confident
          for (const t of tracks) library.addToPlaylist(plId, t);
          trackCount += tracks.length;
        } else {
          const { tracks } = await syncReadSource(p.service, p.id);
          const SLICE = 15;
          for (let i = 0; i < tracks.length; i += SLICE) {
            const rows = await syncMatch("youtube", tracks.slice(i, i + SLICE), i);
            for (const r of rows) {
              if (r.best && r.best.kind === "video" && (r.confidence === "high" || r.confidence === "medium")) {
                library.addToPlaylist(plId, candidateToTrack(r.best));
                trackCount += 1;
              } else if (r.best || r.alternatives.length) {
                flags.push({ playlistId: plId, playlistName: p.title, row: r, choice: r.best?.id ?? "skip" });
              }
            }
            setProgress(`Matching “${p.title}” ${Math.min(i + SLICE, tracks.length)}/${tracks.length}…`);
          }
        }
        library.markSynced(plId, Date.now());
        imported += 1;
      } catch (e) {
        setProgress(`“${p.title}” failed: ${(e as Error).message}`);
      }
    }
    setSummary({ imported, tracks: trackCount });
    setFlagged(flags);
    setStep(flags.length ? "review" : "done");
  }

  function applyReview() {
    let added = 0;
    for (const f of flagged) {
      if (f.choice === "skip") continue;
      const cand = f.row.best?.id === f.choice ? f.row.best : f.row.alternatives.find((a) => a.id === f.choice);
      if (cand && cand.kind === "video") {
        library.addToPlaylist(f.playlistId, candidateToTrack(cand));
        added += 1;
      }
    }
    setSummary((s) => ({ ...s, tracks: s.tracks + added }));
    setStep("done");
  }

  const inner = (
      <div
        className={`wizard ${embedded ? "embedded" : ""}`}
        onPointerDown={embedded ? undefined : (e) => e.stopPropagation()}
      >
        <header className="wizard-head">
          <span className="wizard-title">Set up your library</span>
          {/* Embedded = a library tab: you leave by opening another tab, so no redundant ✕
              (the floating modal keeps one). */}
          {!embedded && (
            <button className="mini x" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </header>

        {step === "connect" && (
          <div className="wizard-body">
            <p className="wizard-lead">Connect a music service to pull your playlists in.</p>
            {(["youtube", "spotify", "tidal"] as Service[]).map((s) => (
              <div key={s} className="wizard-svc">
                <span>{SVC_LABEL[s]}</span>
                {connected(s) ? (
                  <span className="wizard-ok">Connected ✓</span>
                ) : (
                  <button
                    onClick={() => (s === "youtube" ? startGoogleSignIn() : s === "spotify" ? startSpotifyConnect() : startTidalConnect())}
                  >
                    Connect
                  </button>
                )}
              </div>
            ))}
            <footer className="wizard-foot">
              <button onClick={onClose}>Later</button>
              <button className="primary" disabled={!anyConnected} onClick={() => setStep("pick")}>
                Next
              </button>
            </footer>
          </div>
        )}

        {step === "pick" && (
          <div className="wizard-body">
            <p className="wizard-lead">Pick the playlists to import. We’ll match each track to YouTube automatically.</p>
            <div className="wizard-pick">
              {pickables.length === 0 && <div className="wizard-empty">No playlists found on your connected services.</div>}
              {pickables.map((p) => (
                <label key={key(p)} className="wizard-pl">
                  <input type="checkbox" checked={selected.has(key(p))} onChange={() => toggle(key(p))} />
                  <span className="wizard-pl-name">{p.title}</span>
                  <span className="wizard-pl-meta">
                    {SVC_LABEL[p.service]} · {p.count}
                  </span>
                </label>
              ))}
            </div>
            <footer className="wizard-foot">
              <button onClick={() => setStep("connect")}>Back</button>
              <button className="primary" disabled={selected.size === 0} onClick={() => void runImport()}>
                Import {selected.size || ""}
              </button>
            </footer>
          </div>
        )}

        {step === "importing" && (
          <div className="wizard-body wizard-center">
            <div className="wizard-spinner" />
            <p>{progress || "Importing…"}</p>
          </div>
        )}

        {step === "review" && (
          <div className="wizard-body">
            <p className="wizard-lead">
              {flagged.length} match{flagged.length === 1 ? "" : "es"} looked uncertain — confirm or swap, then finish.
            </p>
            <div className="wizard-review">
              {flagged.map((f, i) => (
                <div key={i} className="wizard-flag">
                  <div className="wizard-flag-src">
                    <strong>{f.row.source.title}</strong>
                    <span>
                      {f.row.source.artist} · in {f.playlistName} · {f.row.confidence}
                    </span>
                  </div>
                  <select
                    value={f.choice}
                    onChange={(e) =>
                      setFlagged((cur) => cur.map((x, j) => (j === i ? { ...x, choice: e.target.value } : x)))
                    }
                  >
                    {f.row.best && (
                      <option value={f.row.best.id}>
                        {f.row.best.title} — {f.row.best.artist}
                      </option>
                    )}
                    {f.row.alternatives
                      .filter((a) => a.id !== f.row.best?.id)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title} — {a.artist}
                        </option>
                      ))}
                    <option value="skip">Skip this track</option>
                  </select>
                </div>
              ))}
            </div>
            <footer className="wizard-foot">
              <button onClick={() => setStep("done")}>Skip all</button>
              <button className="primary" onClick={applyReview}>
                Add selected & finish
              </button>
            </footer>
          </div>
        )}

        {step === "done" && (
          <div className="wizard-body wizard-center">
            <p className="wizard-done">✓ Imported {summary.imported} playlist{summary.imported === 1 ? "" : "s"} · {summary.tracks} tracks</p>
            <footer className="wizard-foot">
              <button className="primary" onClick={onClose}>
                Done
              </button>
            </footer>
          </div>
        )}
      </div>
  );
  return embedded ? (
    inner
  ) : (
    <div className="modal-backdrop" onPointerDown={onClose}>
      {inner}
    </div>
  );
}
