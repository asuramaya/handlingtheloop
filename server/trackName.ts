// ─── WHAT IS THIS SONG CALLED? ───────────────────────────────────────────────────────────────
//
// A profile's top-songs list was rendering RAW VIDEO IDS ("2PpBU7EfiEY") for tracks stored without
// metadata, and raw YOUTUBE UPLOAD STRINGS for the rest — "Deadmau5 - HR 8938 Cephei (1080p) || HD"
// by "TheOtherMau5". Neither is what the song is called. One leaks an internal id into a public
// page; the other shows the uploader's filename where an artist belongs.
//
// ★ THE APP ALREADY KNOWS THE ANSWER AND NOBODY ASKED IT. Tracks are fingerprinted
// (Chromaprint → AcoustID → MusicBrainz) to a canonical artist/title/ISRC, cached globally in D1's
// `track_identity`. lyrics/client.ts's canonicalName() has used exactly this for its own lookups
// and says so in its own comment — "identity is a property of the TRACK, not of the recommender" —
// while the profile, three tables away, printed a video id.
//
// So the resolution is a JOIN, and this module is only what happens when the join misses.
//
// THE ORDER MATTERS, best evidence first:
//   1. track_identity — acoustic fingerprint → MusicBrainz. The actual answer.
//   2. community_tracks — the cached-catalogue index, which carries title/artist for anything
//      anyone has ever loaded. Covers the ids stored with no metadata at all.
//   3. this module — parse the uploader's own strings, which is guessing, but it is guessing from
//      conventions YouTube Music itself publishes.
//   4. nothing. Then say "Unknown track", never the id.

/** A YouTube Music auto-generated channel: "Kanye West - Topic" IS the artist, and its uploads
 *  already carry clean titles. This is a convention YouTube publishes, not a heuristic. */
const TOPIC = /\s+-\s+Topic$/i;
/** "DrakeVEVO", "GrimesVEVO" — a label channel. The suffix is the network, not the name. */
const VEVO = /VEVO$/;
/** "tricot Official Channel", "X Official" — self-description, not part of the artist's name. */
const OFFICIAL_CHANNEL = /\s+(Official\s+(Channel|Artist\s+Channel|Music|Videos?)|Channel|Official)$/i;
/** Upload noise: "(Official Video)", "[4K Remastered]", "|| HD", "- Official Audio", trailing tags. */
const BRACKETED = /\s*[([][^)\]]*[)\]]/g;
const TRAILING_TAGS = /\s*(\|\|?|-|–|—)\s*(HD|4K|8K|1080p|720p|MV|Official\s*\w*|Lyrics?\s*\w*|Audio|Visualizer)\s*$/gi;
/** The same tags with NO separator — 'tricot "potage" MV'. Deliberately a SHORTER list: a format
 *  token is never how a song title ends, but "Audio", "Official" and "Lyrics" are ordinary words
 *  and stripping them off a bare space would eat real names. Format only. */
const TRAILING_FORMAT = /\s+(HD|4K|8K|1080p|720p|MV)\s*$/i;

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Strip a channel's network/self-description suffixes down to the artist's actual name. */
export function artistFromChannel(channel: string | null | undefined): string {
  let c = tidy(channel ?? "");
  if (!c) return "";
  if (TOPIC.test(c)) return tidy(c.replace(TOPIC, ""));
  c = tidy(c.replace(OFFICIAL_CHANNEL, ""));
  // VEVO only when it is a SUFFIX on a longer name — "VEVO" alone is not an artist, and a name
  // that merely contains the letters is not a label channel.
  if (VEVO.test(c) && c.length > 4) c = tidy(c.replace(VEVO, ""));
  return c;
}

/** Strip upload noise from a title, repeatedly — "X (Official Video) [HD]" needs more than one pass. */
export function stripUploadNoise(title: string | null | undefined): string {
  let t = tidy(title ?? "");
  if (!t) return "";
  const before = t;
  t = tidy(t.replace(BRACKETED, ""));
  for (let i = 0; i < 3; i++) {
    TRAILING_TAGS.lastIndex = 0;
    const next = tidy(tidy(t.replace(TRAILING_TAGS, "")).replace(TRAILING_FORMAT, ""));
    if (next === t) break;
    t = next;
  }
  TRAILING_TAGS.lastIndex = 0;
  // Never strip a title down to NOTHING. '"potage" MV' losing its quotes is a worse answer than
  // leaving it alone, and a track called "(Sandy) Alex G" is a real name, not noise.
  return t || tidy(before);
}

export interface NameSources {
  /** From track_identity — the fingerprinted answer. Used verbatim when present. */
  identityArtist?: string | null;
  identityTitle?: string | null;
  /** Whatever was stored with the play, or from the community index: the uploader's own strings. */
  title?: string | null;
  artist?: string | null;
}

/** Resolve the best available name for a track. Never returns a video id, and never an empty
 *  title — a caller rendering this has nothing else to show. */
export function resolveTrackName(s: NameSources): { title: string; artist: string } {
  // 1. The fingerprinted identity is the answer whenever it exists. No parsing, no guessing.
  if (s.identityTitle && s.identityArtist) {
    return { title: tidy(s.identityTitle), artist: tidy(s.identityArtist) };
  }

  const rawTitle = tidy(s.title ?? "");
  const channelArtist = artistFromChannel(s.artist);
  const topic = TOPIC.test(tidy(s.artist ?? ""));

  // 2. A "- Topic" channel is YouTube Music's own metadata: the channel IS the artist and the
  //    title is already clean. Splitting such a title on a dash would be actively wrong — it would
  //    turn "Higher - Remastered" into artist "Higher".
  if (topic && rawTitle) return { title: stripUploadNoise(rawTitle), artist: channelArtist };

  // 3. "Artist - Title" in the upload title is the strongest remaining signal, and it BEATS the
  //    channel name: "Deadmau5 - HR 8938 Cephei" uploaded by "TheOtherMau5" is by Deadmau5.
  const dash = rawTitle.match(/^(.{1,80}?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    const artist = tidy(dash[1]);
    const title = stripUploadNoise(dash[2]);
    if (artist && title) return { title, artist };
  }

  // 4. No dash: keep the title, take the artist from the channel if it says anything useful.
  if (rawTitle) return { title: stripUploadNoise(rawTitle), artist: channelArtist };

  // 5. Nothing known. The id is NOT a name — this is the leak the whole module exists to stop.
  return { title: "Unknown track", artist: channelArtist };
}
