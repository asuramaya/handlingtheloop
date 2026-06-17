// Shared HTTP response builders for the Worker. The same `json`/`redirect` pair was
// re-declared in accounts.ts, admin.ts and samples.ts; one definition now.

/** JSON response with `no-store` caching by default. Extra/override headers may be passed. */
export function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** 302 redirect to `location`, with optional extra headers (e.g. a Set-Cookie). */
export const redirect = (location: string, headers?: HeadersInit): Response =>
  new Response(null, { status: 302, headers: { location, ...headers } });
