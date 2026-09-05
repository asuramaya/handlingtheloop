import { useEffect, useState } from "react";

// The single definition of "this is a phone", for the places that need it in JS rather than
// in a media query. Below this width the board shows ONE deck's controls at a time and the FX
// panel becomes a sheet (see board.css / fx.css) — behaviour a stylesheet alone can't express,
// because opening the sheet is an EVENT, not a layout.
// Keep the breakpoint identical to the CSS one: a JS/CSS disagreement here means a sheet that
// opens with nowhere to render, or a panel that vanishes with no way back.
export const PHONE_QUERY = "(max-width: 768px)";

export function usePhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    on(); // a resize across the breakpoint between first paint and this effect
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}
