// A track is identified by its YouTube videoId everywhere in the app.
export interface TrackMeta {
  videoId: string;
  title: string;
  artist: string; // uploader / channel
  duration: number; // seconds
  thumbnail: string | null;
  views: number | null;
  bpm?: number | null; // filled in once analyzed on load
  addedAt?: number; // epoch ms, set when added to the collection
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[]; // videoIds, in order
}
