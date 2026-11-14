import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installHScrollRows } from "./components/hscrollRows";
import { initLifecycle } from "./htl/debug/lifecycle";
import { App } from "./App";
import "./styles.css";

// iOS Safari still fires pinch-zoom gestures even with user-scalable=no — these
// are what jiggle the page and steal inputs from the waveform. Block them.
const stop = (e: Event) => e.preventDefault();
document.addEventListener("gesturestart", stop);
document.addEventListener("gesturechange", stop);
document.addEventListener("gestureend", stop);

installHScrollRows(); // click-drag / wheel slide the FX rows (see hscrollRows.ts)
// How did the last session end — a refresh, or a crash? Read before anything heavy runs, and the
// heartbeat that answers it next time starts here (htl/debug/lifecycle.ts).
initLifecycle();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
