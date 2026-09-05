import { useState } from "react";
import { heroState, type RoomState } from "@htl/room";
import { maskName, toggleRevealed, usePrivacyRevealed } from "@htl/privacy";
import type { DockMode, PanelKey } from "@htl";
import { QRCode } from "./QRCode";
import { CenterResizeHandles, DockPlacementResizer, edgeZIndex, useCenterZIndex } from "./DockResizer";
import { StageBar } from "./social/StageBar";
import { SocialCard } from "./social/SocialCard";
import { RequestList } from "./social/RequestList";
import { ChatPanel } from "./social/ChatPanel";
import { InviteFriends } from "./social/InviteFriends";
import { SetSavedPrompt } from "./social/SetSavedPrompt";
import { InfoDot } from "./settings/InfoDot";
import { deviceIcon } from "./social/util";

// The Session screen — the room you're in or hosting. (The live-rooms DIRECTORY is in People ▸
// Discover; recordings are on People ▸ You.)
//
// ★ REDESIGN. Three faults, each stated as what it cost:
//
//  1. THE TWO "SOMEONE IS WAITING ON YOU" LISTS WERE SEPARATED BY THE CHAT. "Wants to play" sat
//     inside the crowd section, "Wants to join" inside the room section, and ChatPanel rendered
//     between them. They are the same event — a person BLOCKED, waiting for the host to act —
//     and in a busy room the chat grew until the second one was below the fold. They are one
//     WAITING block now, directly under the hero, because an action someone is waiting on
//     outranks every ambient thing on this surface.
//
//  2. IT SPOKE A PRIVATE DIALECT. `social-section-head`, `social-knock`, `social-approve`,
//     `crowd-section`, `room-section` — a parallel vocabulary for cards, rows and buttons the
//     rest of the app had already settled (`.settings-section`, `.settings-row`, `.seg-group`).
//     Same grammar now; only what is genuinely particular to a live room keeps its own class.
//
//  3. THE HERO WAS THREE AD-HOC BRANCHES. It is one named state with one primary action, which
//     is the shape it was reaching for: this is the only surface in the app that HAS a state and
//     a single obvious next move, and that is exactly why it earns a hero when settings tabs do
//     not. The resolution lives in @htl/room/heroState — a priority list is a product decision
//     ("offline outranks live", "a guest is never idle"), and a product decision in a ternary
//     chain inside a 300-line render is a decision nothing can check.

export function SocialScreen({
  room,
  onClose,
  onActivate,
  onQueueRequest,
  dockMode = "right",
  panelOrder = ["library", "settings", "people", "session"],
}: {
  room: RoomState;
  onClose: () => void;
  onActivate?: () => void;
  onQueueRequest?: (text: string, reqId: string) => void; // F1→queue: action a song request onto the auto-mix queue
  dockMode?: DockMode; // desktop placement (Settings ▸ Controls); mobile ignores this and stays full-screen
  panelOrder?: PanelKey[]; // stack priority when an edge/bottom dock overlaps another (Settings ▸ Controls)
}) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false); // private-invite card collapses by default
  const revealed = usePrivacyRevealed();

  const online = room.status === "online";
  const inSession = room.signedIn || room.isGuest;
  const others = room.peers.filter((p) => p.id !== room.you);
  const participants = room.peers.filter((p) => p.joined);
  const sessionLive = participants.length > 0;
  const knocks = room.host ? room.peers.filter((p) => p.pending) : []; // guests waiting on the handshake
  const stageReqs = room.host ? room.stageRequests : [];
  const waiting = knocks.length + stageReqs.length;

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — link + QR shown for manual copy/scan */
    }
  }
  async function makeInvite() {
    setInviting(true);
    const inv = await room.createInvite();
    setInviting(false);
    if (inv) {
      setInviteUrl(inv.url);
      await copyLink(inv.url);
    }
  }

  const startSession = () => {
    onActivate?.();
    room.join();
    room.setControl(true);
    room.setListening(true);
  };
  // Your OWN other device → control extension (drive on, silent); a guest → listener.
  const joinSession = () => {
    onActivate?.();
    room.join();
    if (room.host) room.setControl(true);
    else room.setListening(true);
  };
  // Go live in one move — the redesign's primary action. Ensures the session is started
  // (join + control) then opens the public lobby; no more "Start, then Go live" two-step.
  const goLive = () => {
    if (!room.joined) startSession();
    room.goPublic(true);
  };

  const gateOpts = [
    { m: "request", label: "Request" },
    { m: "open", label: "Open" },
    { m: "closed", label: "Closed" },
  ] as const;

  const broadcasting = room.roomPublic;
  const crowdLive = broadcasting || !!room.listeningTo; // a broadcast exists (you host it, or tuned in)

  // ONE state, resolved once, in priority order — see heroState.ts for why the order is the
  // design and not an implementation detail.
  const state = heroState({
    online,
    pending: room.pending,
    listeningTo: room.listeningTo,
    broadcasting,
    isGuest: room.isGuest,
    signedIn: room.signedIn,
  });

  // Conditionally mounted by App (only exists while open) — mount itself IS "just opened".
  const centerZ = useCenterZIndex(dockMode, true);
  const zIndex = dockMode === "center" ? centerZ : edgeZIndex("session", panelOrder);

  return (
    <div className={`modal-backdrop dock-${dockMode}`} style={{ zIndex }} onPointerDown={onClose}>
      <DockPlacementResizer mode={dockMode} />
      <div className="panel social-screen" onPointerDown={(e) => e.stopPropagation()}>
        {dockMode === "center" && <CenterResizeHandles panelKey="session" />}
        <div className="settings-head">
          <h2>{room.isGuest ? "Guest session" : "Session"}</h2>
          <button
            className={`room-eye ${revealed ? "on" : ""}`}
            onClick={toggleRevealed}
            aria-label={revealed ? "Hide names" : "Reveal names"}
          >
            {revealed ? "🙈" : "👁"}
          </button>
        </div>

        {room.engineStale && (
          <button className="engine-stale-note" onClick={() => location.reload()}>
            ⚠ This set was made on a different app version — refresh to hear it faithfully.
          </button>
        )}

        {!inSession ? (
          <p className="settings-note">Sign in under People ▸ You, or open an invite link, to join a shared session.</p>
        ) : (
          <div className="social-body">
            {/* ── THE HERO: what this room IS right now, and the one thing to do about it. ── */}
            <div className={`room-hero ${state}`}>
              {state === "offline" && (
                <div className="hero-row">
                  <span className="hero-title">{room.status === "error" ? "Offline — retrying…" : "Connecting…"}</span>
                </div>
              )}

              {state === "pending" && (
                <div className="hero-row">
                  <span className="hero-title">⏳ Waiting for the host to let you in…</span>
                </div>
              )}

              {state === "listening" && (
                <>
                  <div className="hero-row">
                    <span className="hero-title">🎧 Listening to <b>@{room.listeningTo}</b></span>
                    <button className="hero-stop" onClick={room.tuneOut}>Stop</button>
                  </div>
                  <StageBar room={room} />
                </>
              )}

              {state === "live" && (
                <>
                  <div className="hero-row">
                    <span className="hero-title">
                      <span className="hero-dot" aria-hidden="true">●</span> LIVE
                      {room.user?.handle && <span className="hero-handle"> @{room.user.handle}</span>}
                    </span>
                    <span className="hero-listeners">{room.listenerCount} listening</span>
                  </div>
                  <button className="hero-end" onClick={() => room.goPublic(false)}>
                    ■ End broadcast
                  </button>
                  {/* Decks access lives WITH the live controls — one place, and in the same
                      segmented language as every other cluster of related options in the app. */}
                  {room.host && (
                    <div className="settings-row">
                      <span className="settings-label">
                        Decks
                        <InfoDot
                          text="How the crowd reaches your decks. Request: a listener raises a hand and you approve each one. Open: any listener can take a free deck instantly. Closed: only you and the people you invited privately can play."
                          label="Decks access"
                        />
                      </span>
                      <span className="settings-control">
                        <span className="seg-group">
                          {gateOpts.map(({ m, label }) => (
                            <button
                              key={m}
                              className={`hw-btn small ${room.stageGate === m ? "on" : ""}`}
                              onClick={() => room.setStageGate(m)}
                              aria-pressed={room.stageGate === m}
                            >
                              {label}
                            </button>
                          ))}
                        </span>
                      </span>
                    </div>
                  )}
                </>
              )}

              {state === "idle" && (
                <>
                  <span className="hero-title idle-title">◦ Not broadcasting</span>
                  {room.user?.handle ? (
                    <>
                      <button className="hero-golive" onClick={goLive} disabled={!online}>
                        ● Go live
                      </button>
                      <span className="hero-sub">
                        Opens <b>@{room.user.handle}</b> to anyone. They tune in to listen, and can ask to step up to
                        the decks.
                      </span>
                    </>
                  ) : (
                    <span className="hero-sub">Claim a @handle under People ▸ You to go live.</span>
                  )}
                </>
              )}
            </div>

            {/* ── WAITING — every person BLOCKED on you, in one list, right under the hero.
                Knocks and stage requests are the same event with different consequences, so
                they are one block; each row says which. ── */}
            {waiting > 0 && (
              <div className="settings-section waiting-section">
                <div className="settings-section-head">
                  <span className="settings-label">Waiting on you</span>
                  <span className="settings-head-note">{waiting}</span>
                </div>

                {knocks.map((p) => (
                  <div key={p.id} className="settings-row">
                    <span className="settings-label">
                      <span className="social-knock-ico" aria-hidden="true">{deviceIcon(p.kind)}</span>
                      {revealed ? p.name : maskName(p.name)}
                    </span>
                    <span className="settings-control">
                      <span className="settings-value">wants to join</span>
                      <span className="seg-group">
                        <button className="hw-btn small" onClick={() => room.approve(p.id)}>Let in</button>
                        <button className="hw-btn small danger" onClick={() => room.deny(p.id)}>Deny</button>
                      </span>
                    </span>
                  </div>
                ))}

                {stageReqs.map((r) => (
                  <div key={r.id} className="settings-row">
                    <span className="settings-label">
                      <span className="social-knock-ico" aria-hidden="true">🎧</span>
                      {revealed ? r.name : maskName(r.name)}
                    </span>
                    <span className="settings-control">
                      <span className="settings-value">deck {r.deck}</span>
                      <span className="seg-group">
                        <button className="hw-btn small" onClick={() => room.approveStage(r.id, r.deck)}>
                          Bring up ▸ {r.deck}
                        </button>
                        <button
                          className="hw-btn small"
                          onClick={() => room.approveStage(r.id, r.deck === "A" ? "B" : "A")}
                          aria-label={`Bring up onto deck ${r.deck === "A" ? "B" : "A"} instead`}
                        >
                          {r.deck === "A" ? "B" : "A"}
                        </button>
                        <button className="hw-btn small danger" onClick={() => room.denyStage(r.id)}>Decline</button>
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Just-recorded prompt (G1b): the only recordings affordance in Session — full
                set management lives on People ▸ You. Self-hides unless a fresh draft landed. */}
            {!room.isGuest && room.signedIn && <SetSavedPrompt setsRev={room.setsRev} />}

            {/* ── THE CROWD — the DJ's read on the audience, wherever a broadcast exists. ── */}
            {crowdLive && (
              <div className="settings-section crowd-section">
                <div className="settings-section-head">
                  <span className="settings-label">The crowd</span>
                  <InfoDot
                    text="Everyone listening to this broadcast. Song requests are ranked by how many people asked for the same thing, and you can send one straight to the auto-mix queue. Chat and reactions are the room talking back."
                    label="The crowd"
                  />
                  {broadcasting && <span className="settings-head-note">{room.listenerCount} listening</span>}
                </div>
                {room.host && <RequestList room={room} host revealed={revealed} onQueue={onQueueRequest} />}
                <ChatPanel room={room} revealed={revealed} />
              </div>
            )}

            {/* Private multi-party chat — a real session with others, but no broadcast. */}
            {!crowdLive && participants.length > 1 && (
              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">Chat</span>
                </div>
                <ChatPanel room={room} revealed={revealed} />
              </div>
            )}

            {/* ── ROOM — who is here and how you're connected. Hidden while tuned into someone
                else's broadcast (you're a read-only listener there). ── */}
            {!room.listeningTo && (
              <div className="settings-section room-section">
                <div className="settings-section-head">
                  <span className="settings-label">Room</span>
                  <InfoDot
                    text="Every device and person in this session. Your own other devices join silently as control extensions, so a phone can drive the same decks as the laptop; guests join as listeners until you bring them up."
                    label="Room"
                  />
                  {participants.length > 0 && <span className="settings-head-note">{participants.length}</span>}
                </div>
                <ul className="social-roster">
                  {room.peers
                    .filter((p) => !p.pending)
                    .map((p) => (
                      <SocialCard key={p.id} room={room} p={p} revealed={revealed} onActivate={onActivate} />
                    ))}
                  {others.length === 0 && !sessionLive && (
                    <li className="social-ghost">Open htl on another device on this account, or invite someone below.</li>
                  )}
                </ul>

                {/* Session control (secondary — the hero owns Go live). */}
                {online && (
                  <div className="settings-row">
                    <span className="settings-label">This device</span>
                    <span className="settings-control">
                      {room.joined ? (
                        <button className="hw-btn small danger" onClick={room.leave}>Leave session</button>
                      ) : room.pending ? (
                        <span className="settings-value">waiting…</span>
                      ) : sessionLive ? (
                        <button className="hw-btn small" onClick={joinSession}>{room.host ? "Join as remote" : "Join session"}</button>
                      ) : room.isGuest ? (
                        <button className="hw-btn small" onClick={joinSession}>Join session</button>
                      ) : (
                        <button className="hw-btn small" onClick={startSession}>Start a private session</button>
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* ── INVITE — bring specific people in. Collapsed: the public lobby is the hero's
                Go live, and this is the narrower, deliberate door. ── */}
            {!room.isGuest && room.signedIn && !room.listeningTo && (
              <div className="settings-section">
                <button
                  className="settings-section-head as-toggle"
                  onClick={() => setInviteOpen((o) => !o)}
                  aria-expanded={inviteOpen}
                >
                  <span className="settings-label">Invite to your session</span>
                  <span className="settings-head-note">{inviteOpen ? "▾" : "▸"}</span>
                </button>
                {inviteOpen && (
                  <>
                    {/* Primary: direct-invite a friend (works live OR private — the landing adapts). */}
                    <InviteFriends live={room.roomPublic} />
                    {/* Secondary: an anonymous link for someone WITHOUT an account / a one-off. */}
                    <div className="settings-row">
                      <span className="settings-label">Invite link</span>
                      <span className="settings-control">
                        <button className="hw-btn small" onClick={makeInvite} disabled={inviting}>
                          {inviting ? "Creating…" : copied ? "Copied ✓" : "Create link"}
                        </button>
                      </span>
                    </div>
                    {inviteUrl && (
                      <div className="room-invite-share">
                        <button type="button" className="room-invite-link" onClick={() => copyLink(inviteUrl)}>
                          {copied ? "Link copied ✓" : inviteUrl.replace(/^https?:\/\//, "")}
                        </button>
                        <QRCode value={inviteUrl} size={172} className="room-invite-qr" />
                        <span className="room-invite-scan">Scan to join on another device</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {room.error && <p className="settings-note bad">{room.error}</p>}
      </div>
    </div>
  );
}
