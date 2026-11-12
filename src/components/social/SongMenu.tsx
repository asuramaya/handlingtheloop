import type { TrackMeta } from "@htl/library";
import { Menu } from "../ContextMenu";

// What you can do with a song anywhere outside the library tables: load it, queue it, keep it.
// (Operator, 2026-11-12: tapping a profile's song should open "a normal song menu, maybe just
// playlist maybe load etc.") The same verbs and labels as the library's own menu
// (lib/TrackContextMenu), in one menu, since there is no left/right-click split here.
export interface SongActions {
  onLoad: (deck: "A" | "B", t: TrackMeta) => void;
  onQueue?: (t: TrackMeta) => void;
  onQueueNext?: (t: TrackMeta) => void;
  playlists?: { id: string; name: string }[];
  onAddToPlaylist?: (playlistId: string, t: TrackMeta) => void;
  onAddToCollection?: (t: TrackMeta) => void;
  inCollection?: (videoId: string) => boolean;
}

export function SongMenu({ x, y, track, actions, onClose }: { x: number; y: number; track: TrackMeta; actions: SongActions; onClose: () => void }) {
  const act = (f: () => void) => () => {
    f();
    onClose();
  };
  const { onLoad, onQueue, onQueueNext, playlists, onAddToPlaylist, onAddToCollection, inCollection } = actions;
  return (
    <Menu x={x} y={y} onClose={onClose} head={track.title || undefined}>
      <button className="fx-palette-item" role="menuitem" onClick={act(() => onLoad("A", track))}>
        ▶ Load to Deck A
      </button>
      <button className="fx-palette-item" role="menuitem" onClick={act(() => onLoad("B", track))}>
        ▶ Load to Deck B
      </button>
      {(onQueue || onQueueNext) && <div className="ctx-sep" />}
      {onQueueNext && (
        <button className="fx-palette-item" role="menuitem" onClick={act(() => onQueueNext(track))}>
          ↑ Play next
        </button>
      )}
      {onQueue && (
        <button className="fx-palette-item" role="menuitem" onClick={act(() => onQueue(track))}>
          ＋ Add to queue
        </button>
      )}
      {(onAddToCollection || (playlists?.length && onAddToPlaylist)) && <div className="ctx-sep" />}
      {onAddToCollection &&
        (inCollection?.(track.videoId) ? (
          <div className="ctx-label">✓ In collection</div>
        ) : (
          <button className="fx-palette-item" role="menuitem" onClick={act(() => onAddToCollection(track))}>
            ＋ Add to collection
          </button>
        ))}
      {!!playlists?.length && onAddToPlaylist && (
        <>
          <div className="ctx-label">Add to playlist</div>
          {playlists.map((p) => (
            <button key={p.id} className="fx-palette-item" role="menuitem" onClick={act(() => onAddToPlaylist(p.id, track))}>
              {p.name}
            </button>
          ))}
        </>
      )}
    </Menu>
  );
}
