import type { Deck } from "@htl/audio";
import { useEngine } from "../App/spine";
import { MasterBand } from "./MasterBand";
import { Crossfader } from "./Crossfader";

// ★ WHAT IS LEFT OF THE I/O STRIP: nothing. The board's row is the crossfader, with the master
// drawn as a hairline directly above it.
//
// The arc, so nobody re-walks it: it began as a full-width strip of seven equal-weight cells above
// the fader, permanently full because its content was gated on `engine.canMic` — which is
// `!!getUserMedia`, i.e. "this is a browser". Gating that properly emptied it. Everything left then
// fitted on one line WITH the fader, which is where the real constraint appeared: the fader's
// centre is a CLAIM (at 50 the mix is equal, and the pixel that says so must be the seam between
// the deck columns), and anything flanking it moves that pixel by half the flanks' difference.
// Balancing the flanks fixes it on a desktop and kills it on a phone — two 163px flanks on a 390px
// board leave the fader 64px of throw. So:
//
//   ★ NOTHING FLANKS THE CROSSFADER, and anything sharing its row must span the FULL width.
//
// The master obeys that by being a band, not a pill (MasterBand). The devices obey it by leaving
// the board entirely for the chin (BoardIo), where a microphone, a recorder and a headphone output
// belong anyway: they are attached to the APP, not to the mix.
export function BoardBar({
  master,
  xfader,
}: {
  master?: { value: number; canControl: boolean; onChange: (v: number) => void };
  xfader: {
    deckA: Deck; deckB: Deck; accentA: string; accentB: string; crossfade: number;
    onCrossfade: (v: number) => void; locked?: boolean; smart?: boolean; enabled?: boolean;
    canControl?: boolean; kbd?: string; onToggleSmart?: () => void; onToggleEnabled?: () => void;
  };
}) {
  const engine = useEngine();
  return (
    <div className="board-bar">
      {master && (
        <MasterBand engine={engine} value={master.value} onChange={master.onChange} disabled={!master.canControl} />
      )}
      <Crossfader {...xfader} />
    </div>
  );
}
