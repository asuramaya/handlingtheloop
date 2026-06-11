import type { TrackMeta } from "@htl/library";
import { Explorer } from "./Explorer";
import { DockResizer } from "./DockResizer";

interface SearchModalProps {
  onClose: () => void;
  onLoad: (deckId: "A" | "B", track: TrackMeta) => void;
  onAdd: (track: TrackMeta) => void;
  inCollection: (videoId: string) => boolean;
  onIngestPlaylist: (listId: string) => Promise<void>;
  playlists: { id: string; name: string }[];
  onAddToPlaylist: (playlistId: string, track: TrackMeta) => void;
  onCreatePlaylistWith: (tracks: TrackMeta[]) => void;
}

// YouTube search lifted into a floating modal (like Settings) so the bottom panel
// stays a focused library-management block. Results still load straight to the
// decks or save to the collection without leaving the modal.
export function SearchModal({
  onClose,
  onLoad,
  onAdd,
  inCollection,
  onIngestPlaylist,
  playlists,
  onAddToPlaylist,
  onCreatePlaylistWith,
}: SearchModalProps) {
  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" grow="left" measure="parent" />
      <div className="panel search-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <button className="mini x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <Explorer
          onLoad={onLoad}
          onAdd={onAdd}
          inCollection={inCollection}
          onIngestPlaylist={onIngestPlaylist}
          playlists={playlists}
          onAddToPlaylist={onAddToPlaylist}
          onCreatePlaylistWith={onCreatePlaylistWith}
        />
      </div>
    </div>
  );
}
