import { useEffect, useRef } from "react";
import { decodeAudio, getCachedTrack, setCachedTrack } from "../audio";
import { analyzeTrackAsync, serializeGrid, ANALYSIS_VERSION } from "../analysis";
import { fetchFeaturesByIsrc, fetchYouTubeAudio, identifyTrack, postAnalysis } from "../media";
import { fingerprintBuffer } from "../fingerprint";
import type { TrackMeta } from "../library/types";
import type { MixQueue } from "./queue";

// Background pre-compute for the auto-mix queue: quietly fetch + decode + analyze the
// NEXT couple of queued tracks that have no key/BPM yet, so harmonic matching engages
// and the transition starts instantly (the decoded buffer + analysis are cached for
// the deck, and contributed to the shared D1 dataset). One track at a time, throttled,
// and abortable — never competes with the live mix for more than one decode.

const GAP_MS = 2000; // pause between precompute jobs
const LOOKAHEAD = 3; // DECODE + analyse only within the first N upcoming tracks (the expensive pass)
// ★ THE CHEAP PASS REACHES FURTHER (operator, 2026-11-04, the queue redesign: most rows read "—"
// for BPM and Key, which also means AUTO plans their transitions blind). An identity probe plus
// the free features DB costs a couple of requests and no decode, so it runs over this many rows.
const ID_LOOKAHEAD = 10;

export function useQueuePrefetch(queue: MixQueue, ctx: BaseAudioContext | null, enabled: boolean): void {
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const busy = useRef(false);
  const idTried = useRef(new Set<string>()); // rows the cheap identity/features pass already asked about

  useEffect(() => {
    if (!enabled || !ctx) return;
    let cancelled = false;
    const ctrl = new AbortController();

    // A track analysed this session (a deck load, an earlier prefetch) is written straight onto its
    // row. It used to be SKIPPED as "already done" and never patched, so a queued track that had
    // been on a deck kept reading "—".
    const patchFromCache = (t: TrackMeta): boolean => {
      const a = getCachedTrack(t.videoId)?.analysis;
      if (!a) return false;
      // only when it ADDS something, so a cached analysis without a key does not re-patch every tick
      if ((t.bpm == null && a.bpm != null) || (t.key == null && a.key?.camelot != null)) {
        queueRef.current.patchAnalysis(t.videoId, { bpm: a.bpm, key: a.key?.camelot ?? null, energy: a.energy });
      }
      return true;
    };
    // Next job: the cheapest useful one. A full decode for the first LOOKAHEAD rows; else the
    // identity/features probe for anything up to ID_LOOKAHEAD rows that has not been asked yet.
    const pick = (): { t: TrackMeta; full: boolean } | null => {
      const up = queueRef.current.upcoming.slice(0, ID_LOOKAHEAD);
      for (let i = 0; i < up.length; i++) {
        const t = up[i];
        if (!t.videoId) continue;
        if (t.bpm != null && t.key != null) continue; // already known
        if (patchFromCache(t)) continue;
        if (i < LOOKAHEAD) return { t, full: true };
      }
      for (const t of up) {
        if (!t.videoId || (t.bpm != null && t.key != null) || idTried.current.has(t.videoId)) continue;
        return { t, full: false };
      }
      return null;
    };

    // Get key/BPM for an ISRC (free DB) and patch it onto the queue. Returns true on hit.
    const tryFeatures = async (videoId: string, isrc: string): Promise<boolean> => {
      const f = await fetchFeaturesByIsrc(isrc, videoId, ctrl.signal);
      if (!cancelled && f && (f.bpm != null || f.key != null)) {
        queueRef.current.patchAnalysis(videoId, { ...f, isrc });
        return true;
      }
      if (!cancelled) queueRef.current.patchAnalysis(videoId, { isrc }); // at least carry the ISRC
      return false;
    };

    const run = async () => {
      if (busy.current || cancelled) return;
      const job = pick();
      if (!job) return;
      const target = job.t;
      const videoId = target.videoId;
      busy.current = true;
      try {
        // 1) Identity. Known ISRC, or a GLOBAL-cache probe (someone else already
        //    fingerprinted this track) — either way, no decode needed yet.
        let isrc = target.isrc ?? null;
        let probe = isrc ? null : await identifyTrack(videoId, null, 0);
        if (!isrc && probe?.identity?.isrc) isrc = probe.identity.isrc;

        // 2) With an ISRC, the global track id, pull key/BPM from the free DB — done.
        if (isrc && (await tryFeatures(videoId, isrc))) return;
        // The cheap pass stops here: no decode for rows beyond LOOKAHEAD.
        idTried.current.add(videoId);
        if (!job.full) return;

        // 3) Novel track: decode once. (Also warms the deck load + shares to D1.)
        const data = await fetchYouTubeAudio(videoId, undefined, ctrl.signal);
        if (cancelled) return;
        const buffer = await decodeAudio(ctx, data);
        if (cancelled) return;

        // 4) Fingerprint → AcoustID → ISRC (the global id), when not yet identified.
        if (!isrc && probe?.needsFingerprint !== false) {
          const fp = await fingerprintBuffer(buffer);
          if (!cancelled) {
            const id = await identifyTrack(videoId, fp, Math.round(buffer.duration));
            if (id.identity?.isrc) {
              isrc = id.identity.isrc;
              if (await tryFeatures(videoId, isrc)) {
                setCachedTrack(videoId, { buffer, analysis: await analyzeTrackAsync(buffer) }); // warm the deck load
                return;
              }
              // no features entry: fall through to the ONE local analysis below (it used to analyse twice)
            }
          }
        }

        // 5) Fallback: local analysis for key/BPM (and keep the ISRC if we got one).
        const analysis = await analyzeTrackAsync(buffer);
        if (cancelled) return;
        setCachedTrack(videoId, { buffer, analysis });
        queueRef.current.patchAnalysis(videoId, { bpm: analysis.bpm, key: analysis.key?.camelot ?? null, energy: analysis.energy, isrc });
        void postAnalysis({
          videoId,
          bpm: analysis.bpm,
          key: analysis.key?.camelot ?? null,
          keyName: analysis.key?.name ?? null,
          beatOffset: analysis.beatgrid?.firstBeat ?? null,
          duration: Math.round(buffer.duration * 1000) / 1000, // ms precision: the reuse gate cannot be tighter than the write
          energy: analysis.energy,
          // Contribute the full grid + version too, uniform with the deck-load poster (Metadata B) —
          // so a prefetch primes the shared cache the same way and the convergence guard applies.
          grid: analysis.beatgrid ? serializeGrid(analysis.beatgrid) : null,
          version: ANALYSIS_VERSION,
        });
      } catch {
        /* best-effort — a failed precompute just means we score from provider order */
      } finally {
        busy.current = false;
      }
    };

    const iv = setInterval(() => void run(), GAP_MS);
    void run();
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(iv);
    };
  }, [enabled, ctx]);
}
