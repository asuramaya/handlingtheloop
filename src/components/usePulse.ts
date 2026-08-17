import { useCallback, useEffect, useRef, useState } from "react";

// A one-shot "that landed" acknowledgement for a control whose action is INVISIBLE at the moment
// you fire it — a tap on a knob that toggles SYNC, a right-click that arms THRU, a click on a
// curve inset that cycles the wave. A button gets this for free from :active; a BUTTONOID (a
// control wearing another control's clothes) does not, so nothing on screen ever confirmed the
// press — you had to hunt for the state it changed and hope you'd looked at it before.
//
// Returns a className to hang on the element and a `fire()` to call from the handler. The class
// ALTERNATES (`p0`/`p1`) between consecutive fires: a CSS animation does not restart when the same
// class is still applied, so a second tap inside the window would otherwise show nothing — exactly
// when the feedback matters most (a fast double-toggle).
export function usePulse(ms = 220): [string, () => void] {
  const [n, setN] = useState(0);
  const t = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (t.current) clearTimeout(t.current);
    },
    [],
  );
  const fire = useCallback(() => {
    if (t.current) clearTimeout(t.current);
    setN((x) => x + 1);
    t.current = window.setTimeout(() => setN(0), ms);
  }, [ms]);
  return [n ? `pulsing p${n % 2}` : "", fire];
}
