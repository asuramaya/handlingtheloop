import { event } from "../debug/trace";

// ★ A TAB THAT DIES DECODING LEAVES NO LOG. It is not an exception, not a rejected promise and not
// an onerror — the process is gone, and the next thing that happens is a fresh boot that looks
// normal. The operator's report is exactly this shape: "ios crashes on the live website, possibly
// ooming on large tracks". Nothing in the codebase could have told them which allocation died.
//
// So: the proven pattern from the GPU/stem separation guard (models.ts), with ONE deliberate
// difference. That guard BLOCKS after a crash, because separation is optional — a user keeps the
// app without it. A track decode is NOT optional: blocking it would turn a memory crash into a
// product that cannot open a song. This guard therefore only WITNESSES. Separating the noticing
// from the doing is the same rule the tripwire and the worker fallback landed on tonight.
//
// What it buys: the boot AFTER a crash can say what was being decoded and how big it was, and the
// ring already carries the resident-bytes line AudioEngine writes on every load — so the pair
// reconstructs "died decoding a 9 MB file with 412 MB already resident" from two independent
// records rather than from arithmetic in a message.

const ARM_KEY = "htl:decodeArm";

export interface DecodeCrashRecord {
  /** Compressed byte length handed to decodeAudioData when the tab went down. */
  bytes: number;
  /** Wall clock at arm time, so the ring's resident-bytes line can be matched to it. */
  at: number;
}

/** Call once at startup. Returns the record if the previous decode never finished, else null. */
export function initDecodeCrashGuard(): DecodeCrashRecord | null {
  try {
    const raw = localStorage.getItem(ARM_KEY);
    if (!raw) return null;
    localStorage.removeItem(ARM_KEY); // one report per crash, never a sticky state
    const rec = JSON.parse(raw) as DecodeCrashRecord;
    if (typeof rec?.bytes !== "number" || typeof rec?.at !== "number") return null;
    event("decode-crash", { bytes: rec.bytes, at: rec.at });
    console.error(
      `[htl] the previous decode never finished — the tab went down while decoding ${(rec.bytes / 1e6).toFixed(1)} MB ` +
        `of compressed audio. Look for the audio-resident line just before it in the flight recorder; ` +
        `this is the memory ceiling, not a codec error.`,
    );
    return rec;
  } catch {
    return null; // no localStorage (private mode / blocked) — simply do not witness
  }
}

// ★ A REFRESH IS NOT A CRASH (operator, 2026-11-14). A reload mid-decode left the flag armed and
// the next boot announced "the tab went down while decoding": measured on a plain page reload. A
// refresh, close or navigation fires pagehide; a crash never does, so clearing the flag there
// leaves it set only by a real death (the stem and GPU guards already work this way).
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    try {
      localStorage.removeItem(ARM_KEY);
    } catch {
      /* ignore */
    }
  });
}

/** Bracket a decodeAudioData call. Never throws, never blocks, never refuses a load. */
export function armDecode(bytes: number): void {
  try {
    localStorage.setItem(ARM_KEY, JSON.stringify({ bytes, at: Date.now() } satisfies DecodeCrashRecord));
  } catch {
    /* ignore */
  }
}
export function disarmDecode(): void {
  try {
    localStorage.removeItem(ARM_KEY);
  } catch {
    /* ignore */
  }
}
