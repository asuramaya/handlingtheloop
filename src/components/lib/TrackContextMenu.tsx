import type { TrackMeta } from "@htl/library";
import { Menu } from "../ContextMenu";
import { versionLabel } from "../../htl/library/songIdentity";
import { displayArtist, fmtTime } from "../../util/format";
import type { MenuState } from "./trackTable";

interface TrackContextMenuProps {
  menu: MenuState;
  onClose: () => void;
  /** trackKey -> track. `menu.ids` are trackKeys, matching TrackTable's row identity. */
  byKey: Map<string, TrackMeta>;
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  onQueue?: (track: TrackMeta) => void; // add to the end of the auto-mix queue
  onQueueNext?: (track: TrackMeta) => void; // jump to the front of the queue
  /** Receives the TRACK, not an id — see TrackTable's own note: videoId and trackKey are both
   *  `string`, so an id here is a mismatch the compiler cannot catch. */
  onRemove?: (track: TrackMeta) => void;
  removeTitle?: string;
  playlists?: { id: string; name: string }[];
  onAddToPlaylist?: (playlistId: string, track: TrackMeta) => void;
  onCreatePlaylistWith?: (tracks: TrackMeta[]) => void;
  onAddToCollection?: (track: TrackMeta) => void;
  inCollection?: (videoId: string) => boolean;
  canFile: boolean;
  onClearSelection: () => void; // remove clears the selection set
  /** The other uploads folded into this row (TrackTable `collapseVersions`), best first. */
  versionsOf?: (t: TrackMeta) => TrackMeta[];
}

/** "Other versions": every upload folded into the row, each loadable onto either deck. */
function OtherVersions({ versions, onLoad, onClose }: { versions: TrackMeta[]; onLoad: (deckId: "A" | "B", track: TrackMeta) => void; onClose: () => void }) {
  if (!versions.length) return null;
  return (
    <>
      <div className="ctx-sep" />
      <div className="ctx-label">Other versions</div>
      {versions.map((v) => (
        <div key={v.videoId || `${v.title}|${v.artist}`} className="ctx-version" title={`${v.title} — ${v.artist}`}>
          {/* The titles all start with the song's name and truncate alike in a narrow menu, so the
              row leads with WHAT the upload is; the full title is the tooltip. */}
          <span className="ctx-version-name">
            {versionLabel(v)}
            <span className="ctx-version-meta">
              {" "}
              · {fmtTime(v.duration)} · {displayArtist(v.artist)}
            </span>
          </span>
          {(["A", "B"] as const).map((d) => (
            <button
              key={d}
              className="fx-palette-item ctx-version-load"
              role="menuitem"
              title={`Load this version to Deck ${d}`}
              onClick={() => {
                onLoad(d, v);
                onClose();
              }}
            >
              {d}
            </button>
          ))}
        </div>
      ))}
    </>
  );
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
  byKey,
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
  versionsOf,
}: TrackContextMenuProps) {
  const tracksOf = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((t): t is TrackMeta => !!t);
  // Only for a single row: "other versions" of a multi-selection has no one answer.
  const single = menu.ids.length === 1 ? byKey.get(menu.ids[0]) : undefined;
  const versions = single && versionsOf ? versionsOf(single) : [];

  return (
    <Menu x={menu.x} y={menu.y} onClose={onClose} head={menu.ids.length > 1 ? `${menu.ids.length} tracks` : undefined}>

        {/* LEFT-click menu: just pick a deck. */}
        {menu.kind === "load" && (
          <>
            <button
              className="fx-palette-item"
              role="menuitem"
              onClick={() => {
                const t = byKey.get(menu.ids[0]);
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
                const t = byKey.get(menu.ids[0]);
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
            <OtherVersions versions={versions} onLoad={onLoad} onClose={onClose} />
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
            <OtherVersions versions={versions} onLoad={onLoad} onClose={onClose} />
            {onRemove && (
              <>
                <div className="ctx-sep" />
                <button
                  className="fx-palette-item danger" role="menuitem"
                  onClick={() => {
                    tracksOf(menu.ids).forEach((t) => onRemove(t));
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
