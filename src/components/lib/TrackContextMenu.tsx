import type { TrackMeta } from "@htl/library";
import { Menu } from "../ContextMenu";
import type { MenuState } from "./trackTable";

interface TrackContextMenuProps {
  menu: MenuState;
  onClose: () => void;
  byId: Map<string, TrackMeta>;
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  onQueue?: (track: TrackMeta) => void; // add to the end of the auto-mix queue
  onQueueNext?: (track: TrackMeta) => void; // jump to the front of the queue
  onRemove?: (videoId: string) => void;
  removeTitle?: string;
  playlists?: { id: string; name: string }[];
  onAddToPlaylist?: (playlistId: string, track: TrackMeta) => void;
  onCreatePlaylistWith?: (tracks: TrackMeta[]) => void;
  onAddToCollection?: (track: TrackMeta) => void;
  inCollection?: (videoId: string) => boolean;
  canFile: boolean;
  onClearSelection: () => void; // remove clears the selection set
}

// The track table's context menu. LEFT-click opens the "load" variant (pick a deck);
// RIGHT-click / long-press opens the "add" variant (file to playlist / collection, remove).
//
// It is the SHARED Menu now, not a second implementation. It used to carry its own backdrop and
// its own `Math.min(x, innerWidth - 210)` placement guess — the same guess ContextMenu was built
// to replace, and one that cannot know how tall this menu is: a right-click near the bottom of a
// long collection opened a menu whose "Remove" sat below the fold. Menu measures, flips and clamps.
export function TrackContextMenu({
  menu,
  onClose,
  byId,
  onLoad,
  onQueue,
  onQueueNext,
  onRemove,
  removeTitle,
  playlists,
  onAddToPlaylist,
  onCreatePlaylistWith,
  onAddToCollection,
  inCollection,
  canFile,
  onClearSelection,
}: TrackContextMenuProps) {
  const tracksOf = (ids: string[]) => ids.map((id) => byId.get(id)).filter((t): t is TrackMeta => !!t);

  return (
    <Menu x={menu.x} y={menu.y} onClose={onClose} head={menu.ids.length > 1 ? `${menu.ids.length} tracks` : undefined}>

        {/* LEFT-click menu: just pick a deck. */}
        {menu.kind === "load" && (
          <>
            <button
              className="fx-palette-item"
              role="menuitem"
              onClick={() => {
                const t = byId.get(menu.ids[0]);
                if (t) onLoad("A", t);
                onClose();
              }}
            >
              ▶ Load to Deck A
            </button>
            <button
              className="fx-palette-item"
              role="menuitem"
              onClick={() => {
                const t = byId.get(menu.ids[0]);
                if (t) onLoad("B", t);
                onClose();
              }}
            >
              ▶ Load to Deck B
            </button>
            {/* Queue actions — "play later" (vs Load = "play now"). Multi-select queues all. */}
            {(onQueue || onQueueNext) && <div className="ctx-sep" />}
            {onQueueNext && (
              <button
                className="fx-palette-item"
                role="menuitem"
                onClick={() => {
                  tracksOf(menu.ids).forEach((t) => onQueueNext(t));
                  onClose();
                }}
              >
                ↑ Play next
              </button>
            )}
            {onQueue && (
              <button
                className="fx-palette-item"
                role="menuitem"
                onClick={() => {
                  tracksOf(menu.ids).forEach((t) => onQueue(t));
                  onClose();
                }}
              >
                ＋ Add to queue
              </button>
            )}
          </>
        )}

        {/* RIGHT-click menu: file the track(s). */}
        {menu.kind === "add" && (
          <>
            {onAddToCollection &&
              (() => {
                const targets = tracksOf(menu.ids).filter((t) => !inCollection?.(t.videoId));
                if (!targets.length) return <div className="ctx-label">✓ In collection</div>;
                return (
                  <button
                    className="fx-palette-item"
                    role="menuitem"
                    onClick={() => {
                      targets.forEach((t) => onAddToCollection(t));
                      onClose();
                    }}
                  >
                    ＋ Add to collection
                  </button>
                );
              })()}
            {canFile && (
              <>
                <div className="ctx-label">Add to playlist</div>
                {(playlists ?? []).map((p) => (
                  <button
                    key={p.id}
                    className="fx-palette-item"
                    role="menuitem"
                    onClick={() => {
                      tracksOf(menu.ids).forEach((t) => onAddToPlaylist?.(p.id, t));
                      onClose();
                    }}
                  >
                    {p.name}
                  </button>
                ))}
                {onCreatePlaylistWith && (
                  <button
                    className="fx-palette-item ctx-new" role="menuitem"
                    onClick={() => {
                      onCreatePlaylistWith(tracksOf(menu.ids));
                      onClose();
                    }}
                  >
                    ＋ New playlist…
                  </button>
                )}
              </>
            )}
            {onRemove && (
              <>
                <div className="ctx-sep" />
                <button
                  className="fx-palette-item danger" role="menuitem"
                  onClick={() => {
                    menu.ids.forEach((id) => onRemove(id));
                    onClearSelection();
                    onClose();
                  }}
                >
                  ✕ {removeTitle ?? "Remove"}
                </button>
              </>
            )}
          </>
        )}
    </Menu>
  );
}
