// useLyricsSync — the session lyrics concern: the host's resolved word-timed captions stream to
// guests (the lyric twin of stem-view sync). Inbound onRoomLyrics applies/persists the host's lines
// (cross-track-contamination-guarded); sendHostLyrics broadcasts THIS device's captions when it's
// the board authority; reprocessLyrics is the user's wipe-and-re-resolve escape hatch. Lifted out
// of App.tsx so a lyrics agent owns this file instead of contending on App. PURE RELOCATION: bodies
// are sed-verbatim; the spine (engine/roomRef) is pulled via useSpine, everything else via `deps`
// destructured to the original names so closures + dep arrays are byte-identical. sendHostLyrics
// reads roomRef.current lazily (hook sits before useRoom). Returns feed App's useRoom (onLyrics),
// the caption-change + join-publish broadcast effects, and a deck's onReprocessLyrics prop. Type-
// only `../App` import erased at build (no cycle). See htl-refactor-monoliths.
import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { resolveLyrics, cacheRemoteLyrics, whisperModel, type LyricsSource, type LyricsLine } from "@htl/lyrics";
import type { DeckId } from "@htl/audio";
import { useSpine } from "./spine";

export interface LyricsSyncDeps {
  captions: Record<DeckId, LyricsLine[]>;
  captionSource: Record<DeckId, LyricsSource | null>;
  setCaptions: Dispatch<SetStateAction<Record<DeckId, LyricsLine[]>>>;
  setCaptionSource: Dispatch<SetStateAction<Record<DeckId, LyricsSource | null>>>;
  setLyricStatus: Dispatch<SetStateAction<Record<DeckId, string | null>>>;
  // Read-narrowed view of App's `latest` ref (covariant `current` → only `.loaded` is touched).
  latest: { readonly current: { loaded: Record<DeckId, string | null> } };
  captionVidRef: MutableRefObject<Record<DeckId, string>>;
  loadSeq: MutableRefObject<Record<DeckId, number>>;
  // Read-only here → covariant `current` so App's MutableRefObject<LyricsModel> assigns in.
  lyricsModelRef: { readonly current: string };
  // Whisper decodes the NEURAL VOCAL STEM — without separation there is nothing to transcribe.
  stemModelRef: { readonly current: string };
}

export interface LyricsSync {
  onRoomLyrics: (deck: DeckId, videoId: string, lines: unknown, source: string) => void;
  reprocessLyrics: (id: DeckId, engineOverride?: "whisper" | "youtube") => void;
  sendHostLyrics: (id: DeckId, force?: boolean) => void;
}

export function useLyricsSync(deps: LyricsSyncDeps): LyricsSync {
  const { engine, roomRef } = useSpine();
  const {
    captions,
    captionSource,
    setCaptions,
    setCaptionSource,
    setLyricStatus,
    latest,
    captionVidRef,
    loadSeq,
    lyricsModelRef,
    stemModelRef,
  } = deps;

  // The host streams its resolved, word-timed lyrics → apply them to this deck's caption ribbon
  // (and persist), so a guest gets the SAME playhead-accurate captions the host sees — even on a
  // phone (no GPU) or with the YouTube engine. The host's stream wins over any local fallback.
  const onRoomLyrics = useCallback(
    (deck: DeckId, videoId: string, lines: unknown, source: string) => {
      const ls = lines as LyricsLine[];
      if (!Array.isArray(ls) || ls.length === 0) return;
      // Only apply/cache the host's lyrics if THIS deck is actually showing that track —
      // otherwise a timing race (host on a different track, or mid-load) would paint and
      // persist the wrong track's lyrics (the cross-track contamination). Always cache the
      // (videoId, lines) pair though: it's correct for that id even if not for this deck now.
      const src = (source as LyricsSource) || "whisper";
      cacheRemoteLyrics(videoId, ls, src);
      if (videoId && videoId !== latest.current.loaded[deck]) return;
      captionVidRef.current[deck] = videoId;
      setCaptions((c) => ({ ...c, [deck]: ls }));
      setCaptionSource((s) => ({ ...s, [deck]: src }));
    },
    [],
  );

  // User "reprocess lyrics": wipe this deck's cached/pooled transcript and re-resolve from
  // scratch — the escape hatch for wrong/contaminated lyrics. `engineOverride` picks the
  // source: "whisper" re-decodes the vocal stem on-device; "youtube" pulls fresh captions.
  const reprocessLyrics = useCallback(
    (id: DeckId, engineOverride?: "whisper" | "youtube") => {
      const vid = latest.current.loaded[id];
      if (!vid) return;
      const seq = loadSeq.current[id];
      const stale = () => seq !== loadSeq.current[id];
      const eng = engineOverride ?? (lyricsModelRef.current === "youtube" ? "youtube" : "whisper");
      captionVidRef.current[id] = "";
      setCaptions((c) => ({ ...c, [id]: [] })); // drop the wrong lyrics immediately
      setCaptionSource((s) => ({ ...s, [id]: null }));
      setLyricStatus((s) => ({ ...s, [id]: eng === "youtube" ? "Reloading captions…" : "Reprocessing lyrics…" }));
      void resolveLyrics({
        videoId: vid,
        deck: engine.deck(id),
        model: whisperModel(lyricsModelRef.current).id, // tolerates a retired id (e.g. the dropped "base")
        engine: eng,
        force: true,
        enabled: true, // explicit user action → decode even if auto-lyrics is off
        stemsEnabled: stemModelRef.current !== "off",
        sampleRate: engine.ctx.sampleRate,
        stale,
        onCues: (cues, source) => {
          if (stale()) return;
          captionVidRef.current[id] = vid;
          setCaptions((c) => ({ ...c, [id]: cues }));
          setCaptionSource((s) => ({ ...s, [id]: source }));
        },
        onStatus: (msg) => {
          if (!stale()) setLyricStatus((s) => ({ ...s, [id]: msg }));
        },
      });
    },
    [engine],
  );

  // HOST streams its resolved, word-timed lyrics to the room (the lyric twin of stem-view
  // streaming). Read via refs so the broadcast effect below isn't a dependency knot; reference-
  // equality on the lines array (fresh per resolve) sends ONCE per resolution, and `force`
  // re-sends to a newly-joined guest even when nothing changed.
  const captionsRef = useRef(captions);
  captionsRef.current = captions;
  const captionSourceRef = useRef(captionSource);
  captionSourceRef.current = captionSource;
  const lastLyricsSent = useRef<Record<DeckId, LyricsLine[] | null>>({ A: null, B: null });
  const sendHostLyrics = useCallback((id: DeckId, force = false) => {
    const r = roomRef.current;
    if (!r) return;
    if (r.status !== "online" || (!r.controlling && !r.isAnchor)) return;
    const lines = captionsRef.current[id];
    if (!lines || !lines.length) return;
    // Broadcast the videoId the lines ACTUALLY belong to (set alongside them in onCues), and
    // only when it still matches the loaded track — never a stale loaded[id] (the cross-track
    // contamination guard). If they've diverged (mid-load), skip until they reconcile.
    const lyricsVid = captionVidRef.current[id];
    if (!lyricsVid || lyricsVid !== latest.current.loaded[id]) return;
    if (!force && lines === lastLyricsSent.current[id]) return;
    lastLyricsSent.current[id] = lines;
    r.sendLyrics(id, lyricsVid, lines, captionSourceRef.current[id] || "whisper");
  }, []);

  return { onRoomLyrics, reprocessLyrics, sendHostLyrics };
}
