// AcoustID lookup: a Chromaprint fingerprint (+ duration) → the canonical recording
// (MusicBrainz id + clean artist/title). Free public service; the application API key
// goes in `client=`. We POST the form (fingerprints are long — avoids URL limits) and
// fail soft (→ null) so a miss/outage degrades to title matching, never breaks.

const LOOKUP_URL = "https://api.acoustid.org/v2/lookup";
const TIMEOUT_MS = 10_000;

export interface AcoustIdMatch {
  mbid: string | null;
  artist: string;
  title: string;
  score: number;
}

interface LookupRecording {
  id?: string;
  title?: string;
  artists?: { name?: string }[];
}
interface LookupResult {
  score?: number;
  recordings?: LookupRecording[];
}
interface LookupResponse {
  status?: string;
  error?: { message?: string };
  results?: LookupResult[];
}

export async function acoustidLookup(apiKey: string, fingerprint: string, durationSec: number): Promise<AcoustIdMatch | null> {
  if (!apiKey || !fingerprint || !durationSec) return null;
  try {
    const body = new URLSearchParams({
      client: apiKey,
      duration: String(Math.round(durationSec)),
      fingerprint,
      meta: "recordings",
    });
    const res = await fetch(LOOKUP_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as LookupResponse;
    if (j.status !== "ok" || !Array.isArray(j.results)) return null;
    // Highest-scoring result that actually resolved to a recording.
    let best: LookupResult | null = null;
    for (const r of j.results) {
      if (!r.recordings?.length) continue;
      if (!best || (r.score ?? 0) > (best.score ?? 0)) best = r;
    }
    const rec = best?.recordings?.[0];
    if (!rec?.id) return null;
    return {
      mbid: rec.id,
      artist: (rec.artists ?? []).map((a) => a.name).filter(Boolean).join(", "),
      title: rec.title ?? "",
      score: best?.score ?? 0,
    };
  } catch {
    return null;
  }
}
