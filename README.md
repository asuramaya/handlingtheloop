# xxit

Browser-based, serverless DJ software that mixes public YouTube playlists,
rekordbox-style. No controller/MIDI yet — core mixing and audio routing.

## How the audio works

Real DJ manipulation (waveforms, EQ, tempo, cue) needs sample-level access to
the audio, i.e. PCM flowing through the Web Audio API. A plain web page can't
fetch YouTube's audio bytes — `googlevideo.com` refuses cross-origin reads. So:

```
YouTube  ->  /api/audio (edge fn: resolve stream + add CORS)  ->  browser
              fetch -> decodeAudioData -> AudioBuffer -> Web Audio graph
```

The edge function is the only off-browser piece, and it's serverless (Vercel
Edge / Cloudflare Worker). Everything else — the whole mixer — runs client-side.

Per deck the signal path is:

```
source -> [time-stretch*] -> EQ3 (low/mid/high) -> trim -> crossfader -> master
```

\* time-stretch (key-lock tempo) is the next engine stage to add; today tempo
uses `playbackRate` (pitch tracks tempo, like vinyl).

## Run it

```bash
pnpm install
pnpm dev
```

Drag an audio file onto a deck (works offline, no backend needed) to exercise
the full engine. The YouTube URL box uses `/api/audio`, which needs the edge
function deployed (or proxied in dev).

## Status (MVP)

- [x] Web Audio engine: 2 decks, EQ3, equal-power crossfader, master
- [x] Transport: play/pause, cue, click-to-seek, tempo (vinyl mode)
- [x] Offline analysis: waveform peaks + coarse BPM estimate
- [x] Local-file input (fully working)
- [x] YouTube edge-proxy interface + client fetch/decode
- [ ] Edge fn: signatureCipher / n-param deciphering (some videos need it)
- [ ] Key-lock tempo (time-stretch stage)
- [ ] Playlist ingest (queue/browse from a public playlist URL)
- [ ] Phase-aligned beatgrid + sync
- [ ] Consent gate for non-copyrighted material

## Caveats

YouTube audio extraction is subject to YouTube's Terms of Service. This project
is intended for non-copyrighted / cleared material; keep the consent gate on.
