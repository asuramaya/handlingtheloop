import { useEffect, useState } from "react";

// The single definition of "this is a phone", for the places that need it in JS rather than
// in a media query. Below this width the board shows ONE deck's controls at a time and the FX
// panel becomes a sheet (see board.css / fx.css) — behaviour a stylesheet alone can't express,
// because opening the sheet is an EVENT, not a layout.
// Keep the breakpoint identical to the CSS one: a JS/CSS disagreement here means a sheet that
// opens with nowhere to render, or a panel that vanishes with no way back.
export const PHONE_QUERY = "(max-width: 768px)";

/**
 * ★ A DIFFERENT QUESTION, DELIBERATELY NOT THE SAME ANSWER.
 *
 * PHONE_QUERY asks "is the BOARD narrow" — a layout question about width, and width alone is
 * the right input for it. This asks "can this DEVICE show a panel beside anything else", and
 * width alone is the wrong input for that, because it answers backwards twice:
 *
 *   • A phone in LANDSCAPE is 844×390 or 932×430. Wider than 768, so the old rule called it a
 *     desktop and handed it the full docking system — resizable edge docks, stack ordering,
 *     centered modals — on a screen 390px tall. A 300px-minimum side dock beside a board, on a
 *     device with no cursor to drag the handle with.
 *   • An iPad is the opposite case and gets it right for the opposite reason: at 820 or 834
 *     portrait, and any size in landscape, it is genuinely desktop-like and should keep every
 *     liberty. That is the exception the width arm already serves, and this must not take it
 *     away.
 *
 * So: narrow, OR short with a coarse pointer. The height arm needs `pointer: coarse` because a
 * short-but-wide DESKTOP window is just a short window — it has a cursor, it can drag a dock
 * edge, and it is not a phone. 560px separates every phone in landscape (≤430) from every
 * tablet in landscape (iPad Mini is 744).
 *
 * The width arm stays at 768 rather than tightening to a phone-only 600, on purpose: it is the
 * same number every stylesheet in this repo already uses, and one breakpoint that is slightly
 * generous beats two that disagree. The cost is an iPad MINI in portrait (744) being treated as
 * a phone — which is what its board layout already does, so the panels now agree with the board
 * instead of contradicting it.
 */
export const ONE_PANEL_QUERY = "(max-width: 768px), (max-height: 560px) and (pointer: coarse)";

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    on(); // a resize across the breakpoint between first paint and this effect
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** True when the viewport has room for exactly ONE panel — see ONE_PANEL_QUERY. Read once, at
 *  the top of the app, and threaded down as a resolved placement rather than re-asked at each
 *  call site: the old code ran `window.matchMedia(...)` inline in four separate launchers, so
 *  "is this a phone" had four answers that only happened to agree. */
export function useOnePanel(): boolean {
  return useMediaQuery(ONE_PANEL_QUERY);
}

/** The same rule outside React, for the one-shot reads (an event handler deciding what to close
 *  right now). Kept beside the hook so there is still only one query string in the codebase. */
export function isOnePanelViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(ONE_PANEL_QUERY).matches;
}
