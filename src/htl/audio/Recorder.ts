// Capture any point of the graph into an AudioBuffer — the sampler's record source. A switchable
// input gain taps whichever node you're sampling (a deck, the mic, the master/PA feed); the tap
// feeds a MediaStreamDestination → MediaRecorder, and stop() decodes the recording back into an
// AudioBuffer ready to drop on a pad. MediaRecorder (not a worklet) keeps it dependency-free and
// universal; the capture format is the best LOSSLESS one this browser offers (recorderFormat.ts),
// falling back to its default where none is.
import { decodeAudio } from "./decode";
import { bufferToWav } from "./encodeWav";
import { pickRecorderMime } from "./recorderFormat";

export type RecordSource = AudioNode | null;

// A finished take: the decoded buffer (immediate playback) + a WAV blob (the upload payload).
// Whatever we captured in, the decoded audio is re-encoded to WAV for upload — a stored opus (or
// webm/pcm) clip wouldn't reload on Safari/iOS; WAV does.
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
    // Lossless where the browser offers it: an opus round trip reads back ABOVE what went in
    // (0.221 dB on a capped sine), and bufferToWav clamps at +/-1, so a lossy take can clip on save
    // while the limiter was never in reduction. See recorderFormat.ts / thread 307cb25b.
    const mime = pickRecorderMime(MediaRecorder.isTypeSupported?.bind(MediaRecorder));
    let mr: MediaRecorder;
    try {
      mr = mime ? new MediaRecorder(this.dest.stream, { mimeType: mime }) : new MediaRecorder(this.dest.stream);
    } catch {
      // A format isTypeSupported() claimed and the constructor then refused: take the default.
      try {
        mr = new MediaRecorder(this.dest.stream);
      } catch {
        return false;
      }
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
