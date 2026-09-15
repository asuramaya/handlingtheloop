// Does the landscape-phone layout actually engage, and is the FX strip ON SCREEN?
// The bug f15158f3 measured: at 844x390 the strip landed at y=565 on a 390px-tall screen.
// That is the ONE number that decides whether 9720a7a worked. Everything else is decoration.
import { chromium } from "playwright-core";

const URL_ = process.argv[2] ?? "https://handlingtheloop.com/";
const W = 844, H = 390;

const b = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(6000);

const out = await p.evaluate((vh) => {
  const q = (s) => matchMedia(s).matches;
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const x = e.getBoundingClientRect();
    return { top: +x.top.toFixed(1), bottom: +x.bottom.toFixed(1), h: +x.height.toFixed(1), w: +x.width.toFixed(1) }; };
  const stage = document.querySelector(".stage");
  const strip = document.querySelector(".fx-rack-bar");
  const sr = strip && strip.getBoundingClientRect();
  // Is the strip reachable? Either inside the viewport, or inside a scrollable ancestor.
  let scrollable = null;
  if (strip) { let el = strip.parentElement;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) {
        scrollable = { cls: el.className, scrollH: el.scrollHeight, clientH: el.clientHeight }; break; }
      el = el.parentElement; } }
  return {
    queries: { coarse: q("(pointer: coarse)"), shortAndCoarse: q("(max-height: 560px) and (pointer: coarse)"), narrow: q("(max-width: 768px)") },
    stageDirection: stage ? getComputedStyle(stage).flexDirection : null,
    lanesFlank: r(".lanes-flank"), decksThird: r(".decks-third"),
    strip: sr ? { top: +sr.top.toFixed(1), bottom: +sr.bottom.toFixed(1) } : null,
    stripOnScreen: sr ? sr.top < vh && sr.bottom > 0 : null,
    stripReachableByScroll: scrollable,
    viewportH: vh,
  };
}, H);

console.log(`landscape probe — ${W}x${H}  ${URL_}`);
console.log(`  media: coarse=${out.queries.coarse}  (max-height:560px)+coarse=${out.queries.shortAndCoarse}  (max-width:768px)=${out.queries.narrow}`);
console.log(`  .stage flex-direction: ${out.stageDirection}   <- 'row' means the landscape layout engaged`);
console.log(`  .lanes-flank ${JSON.stringify(out.lanesFlank)}`);
console.log(`  .decks-third ${JSON.stringify(out.decksThird)}`);
console.log(`  .fx-rack-bar ${JSON.stringify(out.strip)}  onScreen=${out.stripOnScreen}`);
console.log(`  scrollable ancestor: ${out.stripReachableByScroll ? JSON.stringify(out.stripReachableByScroll) : "none"}`);
const verdict = out.queries.shortAndCoarse && out.stageDirection === "row" && (out.stripOnScreen || out.stripReachableByScroll);
console.log(verdict ? "\n✓ landscape layout engaged AND the FX strip is reachable" : "\n✗ NOT satisfied — see the rows above for which leg failed");
await b.close();
process.exit(verdict ? 0 : 2);
