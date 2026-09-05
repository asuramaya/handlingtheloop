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
const LOOKAHEAD = 3; // only precompute within the first N upcoming tracks

export function useQueuePrefetch(queue: MixQueue, ctx: BaseAudioContext | null, enabled: boolean): void {
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled || !ctx) return;
    let cancelled = false;
    const ctrl = new AbortController();

    const pick = (): TrackMeta | null => {
      const up = queueRef.current.upcoming.slice(0, LOOKAHEAD);
      for (const t of up) {
        if (!t.videoId) continue;
        if (t.bpm != null && t.key != null) continue; // already known
        if (getCachedTrack(t.videoId)) continue; // already analyzed this session
        return t;
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
      const target = pick();
      if (!target) return;
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
              setCachedTrack(videoId, { buffer, analysis: await analyzeTrackAsync(buffer) });
              if (await tryFeatures(videoId, isrc)) return;
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
          duration: Math.round(buffer.duration),
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
