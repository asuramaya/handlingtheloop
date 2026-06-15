import type { TrackAnalysis } from "../analysis/analyze";

// Session cache of decoded audio + analysis, keyed by videoId. Loading the same
// track to a deck again (e.g. the other deck, or a re-cue) is then instant — no
// re-download, no re-decode, no re-analysis. Buffers belong to the single
// AudioEngine context, so they're safe to share across decks.

export interface CachedTrack {
  buffer: AudioBuffer;
  analysis: TrackAnalysis;
}

// HEAVY cache (BOUNDED). Each entry holds a full decoded float32 AudioBuffer (~92 MB for a
// 4-min 48 kHz stereo track) + its analysis pyramid, AND the buffer is the SAME reference the
// deck plays from — so an UNBOUNDED Map didn't just "cache", it pinned every track ever loaded
// this session in memory. On a long set (a session host churning tracks → a guest re-loading
// each one) that grew without limit and OOM-killed phones. Bounded LRU below.
const cache = new Map<string, CachedTrack>();

// LIGHT cache (UNBOUNDED, intentionally). Just the BPM + Camelot key — scalars, ~tens of bytes
// per track, so thousands cost nothing. Kept forever so the library columns (withCached →
// getCachedMeta) stay populated for EVERY track analysed this session even after its heavy
// buffer is evicted from the bounded cache above. Splitting heavy from light is what lets us
// cap the buffers hard WITHOUT the bpm/key columns going blank again.
const meta = new Map<string, { bpm: number | null; key: string | null }>();

function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}
// How many decoded buffers to keep. Eviction is always safe: a deck currently playing a track
// still holds its OWN reference (audio never drops), and re-loading an evicted track just
// re-decodes from the IndexedDB audio bytes. The two decks' CURRENT tracks are the most
// recently set, so they're never the eviction target. Small on phones, generous on desktop.
const MAX_ENTRIES = isMobile() ? 2 : 16;

export function getCachedTrack(videoId: string): CachedTrack | undefined {
  // Plain read — deliberately does NOT reorder for LRU. getCachedTrack is also called per
  // VISIBLE library row each render (withCached backfill); reordering on read would let the
  // displayed list, not the loaded decks, decide what survives. Recency is by load (set).
  return cache.get(videoId);
}

export function setCachedTrack(videoId: string, value: CachedTrack): void {
  cache.delete(videoId); // re-insert → move to most-recently-used (a re-load refreshes it)
  cache.set(videoId, value);
  meta.set(videoId, { bpm: value.analysis.bpm ?? null, key: value.analysis.key?.camelot ?? null });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest); // drops the heavy buffer; `meta` keeps the scalars for the columns
  }
}

// BPM/Camelot for a track analysed this session — survives heavy-buffer eviction, so library
// columns stay filled all session. Use this (not getCachedTrack) for display-only backfill.
export function getCachedMeta(videoId: string): { bpm: number | null; key: string | null } | undefined {
  return meta.get(videoId);
}

// Release just the heavy decoded buffer for a track while KEEPING its bpm/key meta. Called when
// a mobile deck has packed its stems into the worklet (the stems are now the audio source, so
// the ~92 MB float32 mix is dead weight). Pairs with Deck.releaseMixBuffer() — both the deck's
// reference and this cache reference must drop for the buffer to actually GC. A later re-load
// just re-decodes from the IndexedDB bytes; columns stay filled via the retained meta.
export function dropCachedBuffer(videoId: string): void {
  cache.delete(videoId);
}
