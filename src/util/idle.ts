// Wait until the browser is idle (with a timeout) so a heavy pass runs AFTER the freshly-loaded
// deck UI has painted, instead of stalling the load. Used by the stem pipeline + the track loader.
export function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (typeof ric === "function") ric(() => resolve(), { timeout: 600 });
    else setTimeout(resolve, 60);
  });
}
