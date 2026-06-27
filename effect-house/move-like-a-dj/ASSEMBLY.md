# Effect House assembly — Move Like a DJ (v1 head-bop slice)

The code in `core/` + `components/` is the game. This file is the part a coding
agent can't do: the GUI assembly inside the Effect House desktop app. Do these
steps once, drop the scripts in, test on device.

## 0. Prereqs
- Install **Effect House** (free desktop app, Mac/Win) + sign in with TikTok.
- Recommended: VS Code + the "JavaScript and TypeScript Nightly" extension
  (Effect House's documented editor setup).

## 1. Scene tree
Create a new project, then add:
- **Face Tracker** object (enables the face algorithm so `AlgorithmManager` has a
  face to read). No children needed — we only read `pitch` from script.
- A **2D Text** object → this auto-creates the orthographic **2D Camera** that
  parents the whole HUD. Rename it `ScoreText`.
- Duplicate it → `ComboText`. Position via its **Screen Transform**.
- A **Screen Image** for the **judgment bar** near the bottom (`anchoredPosition.y`
  ≈ the `LANE_BAR_PX` constant in `MoveLikeADJ.ts`, default −360).
- A pool of **Screen Image** notes: duplicate one ~6–8 times, name them
  `Note0..Note7`, all initially disabled. The script recycles these.

## 2. Scripts
- Assets panel → **Add asset (+) → Script → New Script Component** for each file
  in `core/` and `components/MoveLikeADJ.ts`. Keep the folder structure so the
  relative imports resolve.
- Select a **root scene object** → Inspector → **Add Component** → `MoveLikeADJ`.

## 3. Wire the Inspector (`@serializeProperty` slots)
On the `MoveLikeADJ` component:
- `scoreTextObject` ← drag `ScoreText`
- `comboTextObject` ← drag `ComboText`
- `noteObjects` ← drag `Note0..Note7` (**VERIFY**: if array slots aren't
  supported in your build, switch the script to N single `@serializeProperty`
  slots — see "Verify in-editor" below)
- `startBpm` ← 120

## 4. Audio (do this for the slice, scored independently of it)
- Visual Scripting: **Sound Library → Speaker** so the user's chosen TikTok track
  plays during capture. That's the whole audio graph — scoring never touches it.
- Optional later: also fan the Sound Library stream into **Volume/Onset Detection**
  to drive reactive visual flourishes (NOT scoring; Beats Detection's ~2s delay
  makes it useless for hit-timing).

## 5. Test
- Preview with webcam in-editor; nod on the falling notes.
- **Titlebar → Test performance → Run test** before publishing (frame-rate gate).
- Export to phone via the Effect House mobile app and tune on device (see below).

## Verify in-editor (documented-uncertain — confirm before trusting)
These were flagged UNDOCUMENTED in the API research; check IntelliSense in the
EH-generated project (or `*.d.ts` in the project folder):
1. **`face.pitch` sign** — does pitch DECREASE on a downward nod? If it increases,
   flip `direction` to `+1` in `MoveLikeADJ.headBop`.
2. **Array `@serializeProperty`** for `noteObjects` — if unsupported, use single
   slots.
3. **`getComponent("ScreenTransform" | "Text")`** type strings — confirm exact
   component type names IntelliSense expects.
4. **`setTimeout`** — assume absent; all timing is already off `onUpdate(deltaTime)`.
5. **Typedef location** — find the bundled `apjs` `.d.ts` if you want the `core/`
   files to typecheck standalone.

## On-device tuning constants (in `MoveLikeADJ.ts` / `core/`)
- `headBop.latency` (LATENCY_OFFSET) — single fixed skew correction. Start −0.08s.
- `headBop.velThresh` — raise if idle head movement false-fires, lower if real
  nods are missed.
- `WINDOWS` in `core/judge.ts` — widen if hits feel unfair (err generous).
