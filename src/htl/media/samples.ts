// Client wrappers for the sampler GLOBAL-pad files (account-gated; bytes in R2, index
// in D1 — see server/samples.ts). Deck-region pads never hit the network. Upload sends
// the raw audio bytes as the request body with metadata in the query (no base64 bloat).

export interface SampleDto {
  id: string;
  pad: string; // "g0".."g3"
  name: string;
  durationMs: number | null;
  bytes: number | null;
  createdAt: number;
}

export const MAX_SAMPLE_BYTES = 12 * 1024 * 1024;
export const MAX_SAMPLE_MS = 30_000;

/** Upload (or replace) the clip on a global pad. `bytes` is the original encoded file. */
export async function uploadSample(
  pad: string,
  name: string,
  durationMs: number,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<SampleDto> {
  const q = new URLSearchParams({ pad, name, durationMs: String(Math.round(durationMs)) });
  const res = await fetch(`/api/samples?${q.toString()}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": contentType || "audio/wav" },
    body: bytes,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
  return j as SampleDto;
}

export async function listSamples(): Promise<SampleDto[]> {
  const res = await fetch("/api/samples", { credentials: "same-origin" });
  if (!res.ok) return [];
  const j = (await res.json().catch(() => ({ samples: [] }))) as { samples: SampleDto[] };
  return j.samples ?? [];
}

export async function deleteSample(id: string): Promise<void> {
  await fetch(`/api/samples/${id}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
}

/** URL to fetch a clip's bytes for decoding (owner-only on the server). */
export const sampleAudioUrl = (id: string): string => `/api/samples/${id}/audio`;
