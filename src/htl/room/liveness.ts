// IS THIS SOCKET ALIVE? — the client half of the room's liveness (operator, 2026-11-11: session sync
// audit).
//
// The old watchdog (sessionFollow.isSocketStale) only ran for FOLLOWERS and only measured inbound
// silence. Two failures followed:
//  • the ANCHOR was never checked, so a half-open anchor socket (or an iOS anchor locked mid-set) kept
//    ticking into nothing while the room froze, and if the server did move the anchor the `role`
//    frame never reached it — it stayed "online", believed it was the anchor, and never reconnected;
//  • a follower with no ticks expected had only the 5 s ping keeping inbound alive against a 6 s
//    limit, so one slow pong forced a reconnect that churned the anchor.
//
// Liveness is now PONG-based for every connected device: a ping that has gone unanswered for
// pongTimeoutMs means the link is dead, whatever role this device holds. "Outstanding" is measured
// from the oldest UNANSWERED ping, not from the last pong, so a throttled background tab that simply
// did not send a ping for a minute is not declared dead for its own silence. Inbound staleness is kept
// as a second, faster signal only where it is meaningful: a follower that has actually been receiving
// the anchor's ticks on this connection.
export interface LivenessInput {
  now: number;
  online: boolean; // status === "online"
  hasSocket: boolean;
  /** When the oldest ping still unanswered was sent (0 = none outstanding). */
  pingOutstandingSince: number;
  pongTimeoutMs: number;
  /** A joined follower that has received ticks on this connection (so silence means something). */
  ticksExpected: boolean;
  lastRecvAt: number; // last inbound message (0 = none yet)
  staleMs: number;
  /** Since when the socket has been CLOSING/CLOSED while we still say online (0 = it is open). A
   *  close whose handshake never completes leaves onclose unfired and no ping can even be sent, so
   *  neither signal above ever arms (measured: a host stuck "online" on a CLOSING socket for good
   *  while the room handed its clock away). */
  notOpenSince?: number;
  notOpenMs?: number;
}

export type LivenessVerdict = "ok" | "no-pong" | "stale" | "not-open";

export function livenessVerdict(p: LivenessInput): LivenessVerdict {
  if (!p.online || !p.hasSocket) return "ok"; // nothing to judge: connecting / offline has its own path
  if (p.notOpenSince && p.now - p.notOpenSince >= (p.notOpenMs ?? 1500)) return "not-open";
  if (p.pingOutstandingSince > 0 && p.now - p.pingOutstandingSince >= p.pongTimeoutMs) return "no-pong";
  if (p.ticksExpected && p.lastRecvAt > 0 && p.now - p.lastRecvAt >= p.staleMs) return "stale";
  return "ok";
}
