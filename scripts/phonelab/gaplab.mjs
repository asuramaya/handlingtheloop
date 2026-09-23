#!/usr/bin/env node
// GAPLAB — what a DESKTOP host can see that a PHONE cannot, measured rather than argued.
//
// Why this exists: the operator ruled that a listener's view FOLLOWS the host, and then said the
// hard part out loud — "the desktop host can see both decks and fx at once, mobile can only see one
// deck, and fx only when opened, so it's not as obvious as it seems at first". Following therefore
// means translating a wide layout into one pane, and you cannot design that translation without
// knowing WHICH surfaces have no phone slot. Thread 3a1da460 asks for the gap list first, before
// any code. This produces it from the running app instead of from reading the CSS.
//
// ★ IT RUNS EACH VIEWPORT TWICE AND KEEPS ONLY WHAT BOTH LOADS AGREE ON. The first version diffed
// live CAPTION TEXT as if it were controls — "[Music]", song lyrics — content churn wearing the
// shape of a layout difference, and 94 of the desktop's 100 "buttons" were that. Rather than guess
// which strings are captions, take the intersection of two independent loads: a real layout surface
// is in both, a transcript line is not. The discarded churn is printed, not silently dropped.
//
// SCOPE, stated so it is not oversold: this is a SOLO load at two widths. It is the LAYOUT gap
// list, not the listener gap list — listener-specific surfaces (lock states, a follow indicator,
// a driven view) are not exercised here and need a session.
//
// Usage:
//   node scripts/phonelab/gaplab.mjs                        # production
//   node scripts/phonelab/gaplab.mjs http://localhost:5173/

import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
const cache = resolve(homedir(), ".cache/ms-playwright");
let exe = null;
for (const d of readdirSync(cache)) for (const p of [resolve(cache,d,"chrome-linux/chrome"), resolve(cache,d,"chrome-headless-shell-linux64/chrome-headless-shell")]) if (existsSync(p)) exe ||= p;
const URL_ = process.argv[2] || "https://handlingtheloop.com/";

const probe = async (b, w, h, mobile) => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1 });
  const pg = await ctx.newPage();
  await pg.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pg.waitForTimeout(3500);
  const out = await pg.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
    };
    // Named landmarks: anything with a stable class the app uses for a REGION.
    const regions = {};
    for (const el of document.querySelectorAll("[class]")) {
      for (const c of el.classList) {
        if (!/^(deck|fx|lane|board|bank|panel|strip|rack|foot|head|stage|mix|queue|library|chat|session|viewport|overview|meter|readout)/i.test(c)) continue;
        if (!regions[c]) regions[c] = { n: 0, visible: 0 };
        regions[c].n++;
        if (vis(el)) regions[c].visible++;
      }
    }
    const labelled = [...document.querySelectorAll("button, [role=button], [role=tab]")]
      .filter(vis)
      .map((b) => (b.getAttribute("aria-label") || b.title || b.textContent || "").trim().slice(0, 28))
      .filter((t) => t.length > 0);
    return {
      w: innerWidth, h: innerHeight,
      regionsVisible: Object.entries(regions).filter(([, v]) => v.visible > 0).map(([k, v]) => `${k}x${v.visible}`).sort(),
      buttons: [...new Set(labelled)].sort(),
      buttonCount: labelled.length,
    };
  });
  await ctx.close();
  return out;
};

// ★ RUN EACH VIEWPORT TWICE AND KEEP ONLY WHAT BOTH RUNS AGREE ON. The first pass diffed live
// CAPTION TEXT as if it were controls ("[Music]", "my dam kid turn") — content churn wearing the
// shape of a layout difference. Rather than guess which strings are captions, take the intersection
// of two independent loads: a real layout surface is in both, a transcript line is not.
const b = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const both = (a, c) => a.filter((x) => c.includes(x));
const twice = async (w, h, m) => {
  const r1 = await probe(b, w, h, m);
  const r2 = await probe(b, w, h, m);
  return {
    w: r1.w, h: r1.h,
    regionsVisible: both(r1.regionsVisible, r2.regionsVisible),
    buttons: both(r1.buttons, r2.buttons),
    buttonCount: Math.min(r1.buttonCount, r2.buttonCount),
    churn: [...new Set([...r1.buttons.filter((x) => !r2.buttons.includes(x)), ...r2.buttons.filter((x) => !r1.buttons.includes(x))])],
  };
};
const desk = await twice(1440, 900, false);
const phone = await twice(390, 844, true);
await b.close();
console.log(`\nCONTENT CHURN DISCARDED (differed between two identical loads): desktop ${desk.churn.length}, phone ${phone.churn.length}`);
console.log(`  e.g. ${[...desk.churn, ...phone.churn].slice(0, 6).map((x) => JSON.stringify(x)).join(", ")}`);

const setDiff = (a, c) => a.filter((x) => !c.includes(x));
console.log(`\nDESKTOP ${desk.w}x${desk.h}: ${desk.regionsVisible.length} regions, ${desk.buttonCount} buttons`);
console.log(`PHONE   ${phone.w}x${phone.h}: ${phone.regionsVisible.length} regions, ${phone.buttonCount} buttons`);
console.log(`\nREGIONS ON DESKTOP, ABSENT ON PHONE:\n  ${setDiff(desk.regionsVisible.map(s=>s.split("x")[0]), phone.regionsVisible.map(s=>s.split("x")[0])).join("\n  ") || "(none)"}`);
console.log(`\nREGIONS ON PHONE, ABSENT ON DESKTOP:\n  ${setDiff(phone.regionsVisible.map(s=>s.split("x")[0]), desk.regionsVisible.map(s=>s.split("x")[0])).join("\n  ") || "(none)"}`);
console.log(`\nCONTROLS ON DESKTOP, ABSENT ON PHONE:\n  ${setDiff(desk.buttons, phone.buttons).join("\n  ") || "(none)"}`);
console.log(`\nCONTROLS ON PHONE, ABSENT ON DESKTOP:\n  ${setDiff(phone.buttons, desk.buttons).join("\n  ") || "(none)"}`);
