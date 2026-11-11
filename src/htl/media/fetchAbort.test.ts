import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({ ytStreamHeaders: async () => ({}) }));
import { fetchYouTubeAudio } from "./source";

// ★ THE FAILURE THIS EXISTS FOR: the caller's abort stopped being forwarded the moment the response
// HEADERS arrived, so a load superseded mid-download kept downloading the whole track, unseen —
// a phone joining a session shared its bandwidth with the transfers it had already abandoned.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchYouTubeAudio — an abort reaches the body, not only the request", () => {
  it("aborting after the headers cancels the transfer", async () => {
    let fetchSignal: AbortSignal | undefined;
    let pulls = 0;
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) => {
      fetchSignal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          // A real fetch errors its body when its signal aborts; model exactly that.
          init.signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
        pull(c) {
          pulls++;
          if (pulls === 1) c.enqueue(new Uint8Array(1024));
          return new Promise(() => {}); // then the link goes slow: nothing more for now
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-length": "100000" } }));
    });
    const ctrl = new AbortController();
    const p = fetchYouTubeAudio("abcdefghijk", () => ctrl.abort(), ctrl.signal);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal?.aborted).toBe(true);
  });
});
