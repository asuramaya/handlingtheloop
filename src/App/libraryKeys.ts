// Which keys browse the Library instead of the board — only while it is OPEN. A pure rule so it can
// be tested (see the onKey comment in App.tsx for why it exists).
export type LibraryKeyAction =
  | { kind: "browse"; delta: number }
  | { kind: "sources"; on: boolean }
  | { kind: "load"; toOther: boolean };

export function libraryKeyAction(code: string, shift: boolean, libraryOpen: boolean): LibraryKeyAction | null {
  if (!libraryOpen) return null;
  switch (code) {
    case "ArrowDown":
      return { kind: "browse", delta: 1 };
    case "ArrowUp":
      return { kind: "browse", delta: -1 };
    case "ArrowLeft":
      return { kind: "sources", on: true };
    case "ArrowRight":
      return { kind: "sources", on: false };
    case "Enter":
    case "NumpadEnter":
      return { kind: "load", toOther: shift };
    default:
      return null;
  }
}
