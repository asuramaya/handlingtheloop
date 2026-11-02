// Settings search: filter what is ACTUALLY RENDERED rather than a hand-kept index of labels.
//
// An index would be a second list of every setting, free to drift every time a row is added,
// renamed or moved — and this panel has just moved a dozen rows between sections. Filtering the
// live DOM cannot drift: if a row is on screen in its section, search can find it. Matching reads
// the row's visible text AND the explanation behind its ⓘ (InfoDot carries it as data-search,
// since the bubble itself is not in the DOM until opened), so "latency" finds Quality and
// "motor" finds Start and Brake.

/** Every word of the query appears somewhere in the haystack (case-insensitive). */
export function matches(haystack: string, query: string): boolean {
  const h = haystack.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => h.includes(w));
}

const MISS = "search-miss";

function textOf(el: Element): string {
  const own = (el as HTMLElement).innerText ?? el.textContent ?? "";
  const infos = [...el.querySelectorAll("[data-search]")].map((n) => n.getAttribute("data-search") ?? "");
  return `${own} ${infos.join(" ")}`;
}

/** Hide everything inside `root` that does not match; returns how many controls matched.
 *  Units are rows (`.settings-row`) and tiles (`.tt-tile`, counted whole). A section whose own
 *  heading matches shows all of its contents. A section with no units matches on its whole text. */
export function applySearch(root: HTMLElement, query: string): number {
  const show = (el: Element, on: boolean) => el.classList.toggle(MISS, !on);
  let total = 0;
  for (const group of root.querySelectorAll<HTMLElement>(".search-group")) {
    let groupHits = 0;
    const body = group.querySelector(".search-group-body");
    if (!body) continue;
    for (const section of body.querySelectorAll<HTMLElement>(".settings-section")) {
      const head = section.querySelector(".settings-section-head");
      const headHit = !!head && matches(textOf(head), query);
      const units = [...section.querySelectorAll(".tt-tile, .settings-row")].filter((u) => !u.parentElement?.closest(".tt-tile"));
      let hits = 0;
      if (units.length === 0) {
        hits = headHit || matches(textOf(section), query) ? 1 : 0;
      } else {
        for (const u of units) {
          const hit = headHit || matches(textOf(u), query);
          show(u, hit);
          if (hit) hits++;
        }
      }
      show(section, hits > 0);
      groupHits += hits;
    }
    // Loose content between sections (banners, notes) only shows when it matches itself.
    for (const child of body.children) {
      if (child.classList.contains("settings-section") || child.querySelector(".settings-section")) continue;
      const hit = matches(textOf(child), query);
      show(child, hit);
      if (hit) groupHits++;
    }
    show(group, groupHits > 0);
    total += groupHits;
  }
  return total;
}
