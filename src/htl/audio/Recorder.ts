// Capture any point of the graph into an AudioBuffer — the sampler's record source. A switchable
// input gain taps whichever node you're sampling (a deck, the mic, the master/PA feed); the tap
// feeds a MediaStreamDestination → MediaRecorder, and stop() decodes the recording back into an
// AudioBuffer ready to drop on a pad. MediaRecorder (not a worklet) keeps it dependency-free and
// universal; the opus round-trip is inaudible for short sampler clips.
import { decodeAudio } from "./decode";
import { bufferToWav } from "./encodeWav";

export type RecordSource = AudioNode | null;

// A finished take: the decoded buffer (immediate playback) + a WAV blob (the upload payload).
// We record opus/webm (universal to capture) but re-encode the decoded audio to WAV for upload —
// opus only DECODES on Chromium, so a stored opus clip wouldn't reload on Safari/iOS; WAV does.
export interface Take {
  buffer: AudioBuffer;
  blob: Blob;
}

export class Recorder {
  private readonly input: GainNode; // the single tap; the engine connects a source to it
  private readonly dest: MediaStreamAudioDestinationNode;
  private current: AudioNode | null = null; // currently-connected source (so we can swap cleanly)
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private _maxTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: AudioContext) {
    this.input = ctx.createGain();
    this.dest = ctx.createMediaStreamDestination();
    this.input.connect(this.dest);
  }

  get recording(): boolean {
    return !!this.rec && this.rec.state === "recording";
  }

  /** Point the recorder at a source node (deck output, mic tap, master…). Pass null to detach. */
  setSource(node: RecordSource) {
    if (node === this.current) return;
    if (this.current) {
      try {
        this.current.disconnect(this.input);
      } catch {
        /* ignore */
      }
    }
    this.current = node;
    if (node) node.connect(this.input);
  }

  /** Begin recording the current source. `maxSec` auto-stops (the promise from stop() still
   *  resolves the buffer). No-op if already recording or no source is connected. */
  start(maxSec = 30): boolean {
    if (this.recording || !this.current) return false;
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(this.dest.stream);
    } catch {
      return false;
    }
    this.chunks = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    mr.start();
    this.rec = mr;
    if (maxSec > 0) this._maxTimer = setTimeout(() => void this.stop(), maxSec * 1000);
    return true;
  }

  /** Stop the take → the decoded buffer + the encoded blob (null if nothing captured / no decode). */
  async stop(): Promise<Take | null> {
    const mr = this.rec;
    if (!mr) return null;
    if (this._maxTimer) {
      clearTimeout(this._maxTimer);
      this._maxTimer = null;
    }
    const done = new Promise<void>((resolve) => {
      mr.onstop = () => resolve();
    });
    if (mr.state !== "inactive") mr.stop();
    this.rec = null;
    await done;
    if (!this.chunks.length) return null;
    const blob = new Blob(this.chunks, { type: this.chunks[0].type || "audio/webm" });
    this.chunks = [];
    try {
      const buffer = await decodeAudio(this.ctx, await blob.arrayBuffer());
      return { buffer, blob: bufferToWav(buffer) }; // re-encode to WAV so it reloads on any device
    } catch {
      return null;
    }
  }

  dispose() {
    if (this._maxTimer) clearTimeout(this._maxTimer);
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.setSource(null);
  }
}
