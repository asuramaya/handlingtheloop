import { useCallback, useEffect, useState } from "react";
import { Store, migrateLegacyKey } from "../persistence";
import type { Playlist, TrackMeta } from "./types";

// Persistent library: the collection (every track you've saved) plus playlists
// (ordered lists of videoIds). Only metadata is persisted (localStorage) —
// audio lives in the IndexedDB cache. Mirrors rekordbox's Collection +
// Playlists model.

interface LibraryData {
  collection: TrackMeta[];
  playlists: Playlist[];
}

const store = new Store<LibraryData>("library", { collection: [], playlists: [] }, 1);
migrateLegacyKey("xxit.library.v1", store);

function load(): LibraryData {
  const d = store.get();
  return Array.isArray(d.collection) && Array.isArray(d.playlists) ? d : { collection: [], playlists: [] };
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `pl_${Date.now().toString(36)}_${idCounter}`;
}

export interface Library {
  collection: TrackMeta[];
  playlists: Playlist[];
  addTrack: (track: TrackMeta) => void;
  removeTrack: (videoId: string) => void;
  setBpm: (videoId: string, bpm: number) => void;
  setKey: (videoId: string, key: string) => void;
  createPlaylist: (name: string, sourceListId?: string, sourceService?: string) => string;
  renamePlaylist: (id: string, name: string) => void;
  deletePlaylist: (id: string) => void;
  linkSource: (id: string, sourceListId: string, sourceService?: string) => void;
  addToPlaylist: (playlistId: string, track: TrackMeta) => void;
  removeFromPlaylist: (playlistId: string, videoId: string) => void;
}

export function useLibrary(): Library {
  const [data, setData] = useState<LibraryData>(load);

  useEffect(() => {
    store.set(data);
  }, [data]);

  const addTrack = useCallback((track: TrackMeta) => {
    setData((d) => {
      if (d.collection.some((t) => t.videoId === track.videoId)) return d;
      return {
        ...d,
        collection: [{ ...track, addedAt: Date.now() }, ...d.collection],
      };
    });
  }, []);

  const removeTrack = useCallback((videoId: string) => {
    setData((d) => ({
      collection: d.collection.filter((t) => t.videoId !== videoId),
      playlists: d.playlists.map((p) => ({
        ...p,
        trackIds: p.trackIds.filter((id) => id !== videoId),
      })),
    }));
  }, []);

  const setBpm = useCallback((videoId: string, bpm: number) => {
    setData((d) => {
      if (!d.collection.some((t) => t.videoId === videoId && t.bpm == null)) return d;
      return {
        ...d,
        collection: d.collection.map((t) =>
          t.videoId === videoId ? { ...t, bpm } : t,
        ),
      };
    });
  }, []);

  const setKey = useCallback((videoId: string, key: string) => {
    setData((d) => {
      if (!d.collection.some((t) => t.videoId === videoId && t.key == null)) return d;
      return {
        ...d,
        collection: d.collection.map((t) =>
          t.videoId === videoId ? { ...t, key } : t,
        ),
      };
    });
  }, []);

  const createPlaylist = useCallback((name: string, sourceListId?: string, sourceService?: string) => {
    const id = newId();
    setData((d) => ({
      ...d,
      playlists: [...d.playlists, { id, name: name.trim() || "New playlist", trackIds: [], sourceListId, sourceService }],
    }));
    return id;
  }, []);

  const renamePlaylist = useCallback((id: string, name: string) => {
    setData((d) => ({
      ...d,
      playlists: d.playlists.map((p) => (p.id === id ? { ...p, name } : p)),
    }));
  }, []);

  const deletePlaylist = useCallback((id: string) => {
    setData((d) => ({ ...d, playlists: d.playlists.filter((p) => p.id !== id) }));
  }, []);

  // Link a local playlist to its source list (YouTube/Spotify) so future imports of
  // that list merge into it instead of creating a duplicate. Only sets it if unset.
  const linkSource = useCallback((id: string, sourceListId: string, sourceService?: string) => {
    setData((d) => ({
      ...d,
      playlists: d.playlists.map((p) =>
        p.id === id && !p.sourceListId ? { ...p, sourceListId, sourceService: sourceService ?? p.sourceService } : p,
      ),
    }));
  }, []);

  // Adding to a playlist also ensures the track exists in the collection.
  const addToPlaylist = useCallback((playlistId: string, track: TrackMeta) => {
    setData((d) => {
      const collection = d.collection.some((t) => t.videoId === track.videoId)
        ? d.collection
        : [{ ...track, addedAt: Date.now() }, ...d.collection];
      const playlists = d.playlists.map((p) =>
        p.id === playlistId && !p.trackIds.includes(track.videoId)
          ? { ...p, trackIds: [...p.trackIds, track.videoId] }
          : p,
      );
      return { collection, playlists };
    });
  }, []);

  const removeFromPlaylist = useCallback((playlistId: string, videoId: string) => {
    setData((d) => ({
      ...d,
      playlists: d.playlists.map((p) =>
        p.id === playlistId ? { ...p, trackIds: p.trackIds.filter((id) => id !== videoId) } : p,
      ),
    }));
  }, []);

  return {
    collection: data.collection,
    playlists: data.playlists,
    addTrack,
    removeTrack,
    setBpm,
    setKey,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    linkSource,
    addToPlaylist,
    removeFromPlaylist,
  };
}
