import { createContext } from "react";

// ★ THE TABLE'S TOOLBAR LIVES IN THE LIBRARY'S TITLE ROW (operator, 2026-11-05: "dead space.
// possibly move search bar to the head"). The filter / search field and its chips used to be a
// row of their own under the title row — a whole bar of height for one field. The Library renders
// an empty slot in its title row and provides it here; the visible TrackTable portals its toolbar
// into it. Only one table is on screen at a time, so there is never more than one tenant. Null
// (a table outside the Library) → the table keeps its own toolbar row.
export const ToolbarHostContext = createContext<HTMLElement | null>(null);
