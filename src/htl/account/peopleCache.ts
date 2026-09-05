import type { PersonCard } from "./index";

// A tiny module-level cache for the PAGED graph lists.
//
// ★ REMEMBERING THE COUNT IS NOT REMEMBERING THE LIST. The People tab's view state can record
// "you had 150 rows loaded", but restoring that by re-fetching three pages is three round-trips
// to show you what you were already looking at — and it flashes an empty list on the way. So the
// ROWS are cached here, not just the fact of them.
//
// Module-level on purpose: it has to outlive the component (which unmounts on every tab switch)
// AND the dock (which unmounts on close). Keyed by whose graph and which side of it, because
// following and followers are different lists of different lengths.
//
// ★ NO TTL — SESSION-LIFETIME. It had one, 60 s, and that was wrong for the case it exists to
// serve: stepping into somebody's profile and coming back is not "later", it is the same
// continuous act. Measured — page to 250 rows, open a person, come back a minute on, and the
// cache had expired: 250 rows collapsed to 50 and the restored scroll position clamped to the
// top of a list that was suddenly a fifth as long. The depth you paged to and the place you
// scrolled to are worth more than sixty-second freshness in a BROWSE list, and every action on a
// row (follow, invite, knock) does its own fetch and its own optimistic update, so nothing the
// user can DO depends on this being fresh. It is cleared when the identity changes, which is the
// only event that actually invalidates it — every entry is viewer-relative.
export interface GraphPage {
  list: PersonCard[];
  more: boolean;
  at: number;
}

const cache = new Map<string, GraphPage>();

const key = (handle: string, mode: string) => `${mode}:${handle}`;

export function readGraph(handle: string, mode: string): GraphPage | null {
  return cache.get(key(handle, mode)) ?? null;
}

export function writeGraph(handle: string, mode: string, list: PersonCard[], more: boolean): void {
  cache.set(key(handle, mode), { list, more, at: Date.now() });
}

/** Drop everything — used when the signed-in identity changes, since every entry is
 *  viewer-relative (following/followsYou are computed against the viewer). */
export function clearGraphCache(): void {
  cache.clear();
}
