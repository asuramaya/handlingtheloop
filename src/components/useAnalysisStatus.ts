import { useEffect, useReducer } from "react";
import { primeAnalysis, subscribeAnalysis } from "@htl/media";

// Subscribe a list to the pooled BPM/key analysis (mirrors useCacheStatus): primes the given
// videoIds (batched, fetched once each) and re-renders when their analysis lands. Returns a
// version counter callers fold into their sort/render memo so the enriched view recomputes.
export function useAnalysisStatus(videoIds: string[]): number {
  const [ver, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeAnalysis(() => bump()), []);
  // Re-prime when the set changes. primeAnalysis is idempotent (dedupes by id), so an unstable
  // array ref just no-ops after the first fetch — no churn cost.
  useEffect(() => {
    primeAnalysis(videoIds);
  }, [videoIds]);
  return ver;
}
