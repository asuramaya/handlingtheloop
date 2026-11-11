// ONE DEVICE ID PER TAB, EVEN FOR A DUPLICATED TAB (operator, 2026-11-11: session sync audit).
//
// The room's device id lives in sessionStorage so each tab is its own participant (client.ts
// deviceId). But the browser's Duplicate Tab COPIES sessionStorage, so the copy arrives wearing the
// original's id; the room keeps one socket per device, so the two tabs replaced each other's socket
// forever (a 'replaced' close was not terminal and the retry reset on every open).
//
// On startup a tab announces its id on a BroadcastChannel; any OTHER live tab already holding that id
// answers "taken", and the newcomer mints a fresh id before it ever connects. The room's terminal
// 4004 'replaced' close (server/room.ts) is the backstop for when no answer comes in time (a frozen
// background tab, a browser without BroadcastChannel).
//
// The channel and the storage are injected so the handshake is testable without a browser.
export interface IdStore {
  get(): string | null;
  set(id: string): void;
}

export interface ClaimChannel {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

type ClaimMsg = { t: "hello"; id: string; nonce: string } | { t: "taken"; id: string; nonce: string };

export function mintDeviceId(): string {
  return "d-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export class DeviceIdClaim {
  id: string;
  /** Resolves with the id this tab should connect as: after a "taken" (re-minted) or the timeout. */
  readonly ready: Promise<string>;
  /** True when this tab arrived wearing a sibling's id and minted a fresh one. */
  reminted = false;
  private readonly nonce = Math.random().toString(36).slice(2);

  constructor(
    private store: IdStore,
    channel: ClaimChannel | null,
    timeoutMs = 250,
  ) {
    let id = store.get();
    if (!id) {
      id = mintDeviceId();
      store.set(id);
    }
    this.id = id;
    if (!channel) {
      this.ready = Promise.resolve(id);
      return;
    }
    let settle: (id: string) => void = () => {};
    this.ready = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => settle(this.id), timeoutMs);
    channel.onmessage = (ev) => {
      const m = ev.data as ClaimMsg | null;
      if (!m || typeof m !== "object" || typeof m.id !== "string") return;
      if (m.t === "hello" && m.id === this.id && m.nonce !== this.nonce) {
        // Someone just woke up wearing OUR id → tell them it is taken. We keep it: we were here first.
        channel.postMessage({ t: "taken", id: m.id, nonce: m.nonce } satisfies ClaimMsg);
      } else if (m.t === "taken" && m.nonce === this.nonce && m.id === this.id) {
        this.id = mintDeviceId();
        this.reminted = true;
        this.store.set(this.id);
        clearTimeout(timer);
        settle(this.id);
      }
    };
    channel.postMessage({ t: "hello", id, nonce: this.nonce } satisfies ClaimMsg);
  }
}
