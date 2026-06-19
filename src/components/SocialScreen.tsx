import { useState } from "react";
import type { RoomState } from "@htl/room";
import { maskName, toggleRevealed, usePrivacyRevealed } from "@htl/privacy";
import { QRCode } from "./QRCode";
import { DockResizer } from "./DockResizer";
import { StageBar } from "./social/StageBar";
import { CrowdPanel } from "./social/CrowdPanel";
import { SocialCard } from "./social/SocialCard";
import { RequestList } from "./social/RequestList";
import { ChatPanel } from "./social/ChatPanel";
import { SetSavedPrompt } from "./social/SetSavedPrompt";
import { deviceIcon } from "./social/util";

// The Session screen — the room you're in/hosting (the live-rooms DIRECTORY is in Discover;
// recordings are on Profile). REDESIGN (docs/social-layer.md → "Surface architecture"): a
// state-driven console, NOT a flat dump. A STATUS HERO names the room's current state + its
// one primary action (Go live / End broadcast / Listening); below it the body is contextual —
// THE CROWD (hype+reactions+chat+requests+gate, only when a broadcast exists), then ROOM
// (roster + knocks + session control), then a collapsed INVITE. Leaf pieces live in ./social/.
export function SocialScreen({ room, onClose, onActivate }: { room: RoomState; onClose: () => void; onActivate?: () => void }) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false); // private-invite card collapses by default (decongest)
  const revealed = usePrivacyRevealed();

  const online = room.status === "online";
  const inSession = room.signedIn || room.isGuest;
  const others = room.peers.filter((p) => p.id !== room.you);
  const participants = room.peers.filter((p) => p.joined);
  const sessionLive = participants.length > 0;
  const knocks = room.host ? room.peers.filter((p) => p.pending) : [];

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

  // The decks-access gate (live host) — part of the crowd console.
  const gateOpts = [
    { m: "request", label: "Request", title: "Listeners raise a hand; you approve" },
    { m: "open", label: "Open", title: "Listeners grab any free deck instantly" },
    { m: "closed", label: "Closed", title: "Only you (and private invitees) play" },
  ] as const;

  const broadcasting = room.roomPublic;
  const crowdLive = broadcasting || !!room.listeningTo; // a broadcast exists (you host it, or tuned in)

  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" measure="parent" />
      <div className="panel social-screen" onPointerDown={(e) => e.stopPropagation()}>
        <div className="social-head">
          <span className="social-title">{room.isGuest ? "Guest session" : "Session"}</span>
          <span className="social-head-tools">
            <button
              className={`room-eye ${revealed ? "on" : ""}`}
              onClick={toggleRevealed}
              title={revealed ? "Hide names (streaming-safe)" : "Reveal names"}
              aria-label={revealed ? "Hide names" : "Reveal names"}
            >
              {revealed ? "🙈" : "👁"}
            </button>
          </span>
        </div>

        {room.engineStale && (
          <button className="engine-stale-note" onClick={() => location.reload()} title="Reload the app">
            ⚠ This set was made on a different app version — refresh to hear it faithfully.
          </button>
        )}

        {!inSession ? (
          <p className="social-hint">Sign in under Profile, or open an invite link, to join a shared session.</p>
        ) : (
          <div className="social-body">
            {!online && <div className="social-offline">{room.status === "error" ? "Offline — retrying…" : "Connecting…"}</div>}
            {room.pending && <div className="social-waiting">⏳ Waiting for the host to let you in…</div>}

            {/* ── STATUS HERO — the room's current state + its single primary action ── */}
            {room.listeningTo ? (
              <div className="room-hero listening">
                <div className="hero-row">
                  <span className="hero-title">🎧 Listening to <b>@{room.listeningTo}</b></span>
                  <button className="hero-stop" onClick={room.tuneOut}>Stop</button>
                </div>
                <StageBar room={room} />
              </div>
            ) : broadcasting ? (
              <div className="room-hero live">
                <div className="hero-row">
                  <span className="hero-title">
                    <span className="hero-dot" aria-hidden="true">●</span> LIVE
                    {room.user?.handle && <span className="hero-handle"> @{room.user.handle}</span>}
                  </span>
                  <span className="hero-listeners">{room.listenerCount} listening</span>
                </div>
                <button className="hero-end" onClick={() => room.goPublic(false)} title="Close the public lobby">
                  ■ End broadcast
                </button>
              </div>
            ) : !room.isGuest && room.signedIn ? (
              <div className="room-hero idle">
                <span className="hero-title idle-title">◦ Not broadcasting</span>
                {room.user?.handle ? (
                  <>
                    <button className="hero-golive" onClick={goLive} disabled={!online} title="Open your room to anyone at your @handle">
                      ● Go live
                    </button>
                    <span className="hero-sub">
                      Open <b>@{room.user.handle}</b> to anyone — they tune in to listen and can ask to step up to the decks.
                    </span>
                  </>
                ) : (
                  <span className="broadcast-hint">Claim a @handle in Profile to go live.</span>
                )}
              </div>
            ) : null}

            {/* Just-recorded prompt (G1b): the only recordings affordance in Session — full
                set management lives on Profile. Self-hides unless a fresh draft just landed. */}
            {!room.isGuest && room.signedIn && <SetSavedPrompt setsRev={room.setsRev} />}

            {/* ── THE CROWD — hype + reactions + chat + requests + gate, only where a broadcast
                exists (you host one, or you've tuned in). The DJ's read on the audience. ── */}
            {crowdLive && (
              <section className="crowd-section">
                <div className="social-section-head">The crowd{broadcasting ? ` · ${room.listenerCount}` : ""}</div>
                <CrowdPanel room={room} />

                {/* HOST: the crowd-ranked song requests (F1 + F3) with moderation. */}
                {room.host && <RequestList room={room} host revealed={revealed} />}

                {/* HOST: listeners raising a hand to step up to the decks (E3–E6). */}
                {room.host && room.stageRequests.length > 0 && (
                  <div className="social-knocks stage-reqs">
                    <div className="social-section-head">✋ Wants to play</div>
                    {room.stageRequests.map((r) => (
                      <div key={r.id} className="social-knock">
                        <span className="social-knock-ico" aria-hidden="true">🎧</span>
                        <span className="social-knock-name">
                          {revealed ? r.name : maskName(r.name)}
                          <span className="stage-req-deck"> · deck {r.deck}</span>
                        </span>
                        <span className="social-knock-acts">
                          <button className="social-approve" onClick={() => room.approveStage(r.id, r.deck)} title={`Bring up onto deck ${r.deck}`}>
                            Bring up ▸ {r.deck}
                          </button>
                          <button
                            className="stage-alt"
                            onClick={() => room.approveStage(r.id, r.deck === "A" ? "B" : "A")}
                            title={`Bring up onto deck ${r.deck === "A" ? "B" : "A"} instead`}
                          >
                            {r.deck === "A" ? "B" : "A"}
                          </button>
                          <button className="social-deny" onClick={() => room.denyStage(r.id)}>Decline</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <ChatPanel room={room} revealed={revealed} />

                {/* HOST: how the crowd reaches the decks (live only). */}
                {room.host && broadcasting && (
                  <div className="gate-select" role="group" aria-label="How the crowd reaches the decks">
                    <span className="gate-label">Decks</span>
                    {gateOpts.map(({ m, label, title }) => (
                      <button
                        key={m}
                        className={`gate-opt ${room.stageGate === m ? "on" : ""}`}
                        onClick={() => room.setStageGate(m)}
                        title={title}
                        aria-pressed={room.stageGate === m}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Private multi-party chat — a real session with others, but no broadcast. */}
            {!crowdLive && participants.length > 1 && <ChatPanel room={room} revealed={revealed} />}

            {/* ── ROOM — knocks + roster + session control. Hidden while tuned into someone
                else's broadcast (you're a read-only listener there). ── */}
            {!room.listeningTo && (
              <section className="room-section">
                {knocks.length > 0 && (
                  <div className="social-knocks">
                    <div className="social-section-head">Wants to join</div>
                    {knocks.map((p) => (
                      <div key={p.id} className="social-knock">
                        <span className="social-knock-ico" aria-hidden="true">{deviceIcon(p.kind)}</span>
                        <span className="social-knock-name">{revealed ? p.name : maskName(p.name)}</span>
                        <span className="social-knock-acts">
                          <button className="social-approve" onClick={() => room.approve(p.id)}>Let in</button>
                          <button className="social-deny" onClick={() => room.deny(p.id)}>Deny</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="social-section-head">Room{participants.length > 0 ? ` · ${participants.length}` : ""}</div>
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

                {/* Session control (secondary — the hero owns Go live). Start a private session,
                    join one in progress, or leave. */}
                {online &&
                  (room.joined ? (
                    <button className="room-leave-link" onClick={room.leave}>Leave session</button>
                  ) : room.pending ? null : sessionLive ? (
                    <button className="room-join-link" onClick={joinSession}>{room.host ? "Join as remote" : "Join session"}</button>
                  ) : room.isGuest ? (
                    <button className="room-join-link" onClick={joinSession}>Join session</button>
                  ) : (
                    <button className="room-start-link" onClick={startSession}>Start a private session</button>
                  ))}

                {/* INVITE — bring specific people in (collapsed; they knock, you approve, they
                    can co-DJ). The public lobby is the hero's Go live, not duplicated here. */}
                {!room.isGuest && room.signedIn && (
                  <div className="share-mode private">
                    <button className="share-mode-head as-toggle" onClick={() => setInviteOpen((o) => !o)} aria-expanded={inviteOpen}>
                      <span className="share-mode-title">🔒 Invite specific people</span>
                      <span className="share-mode-caret">{inviteOpen ? "▾" : "▸"}</span>
                    </button>
                    {inviteOpen && (
                      <>
                        <span className="share-mode-sub">A private link. They knock, you approve — and they can take the decks.</span>
                        <button className="room-invite" onClick={makeInvite} disabled={inviting}>
                          {inviting ? "Creating link…" : copied ? "Link copied ✓" : "Invite people"}
                        </button>
                        {inviteUrl && (
                          <div className="room-invite-share">
                            <button type="button" className="room-invite-link" title="Tap to copy" onClick={() => copyLink(inviteUrl)}>
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
              </section>
            )}
          </div>
        )}

        {room.error && <p className="room-err">{room.error}</p>}
      </div>
    </div>
  );
}
