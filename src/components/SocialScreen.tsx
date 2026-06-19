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
import { RecordingsPanel } from "./social/RecordingsPanel";
import { deviceIcon } from "./social/util";

// The Session "social screen" — the room you're in/hosting (the live-rooms DIRECTORY moved
// out to DiscoverScreen; this is purely the room now). ORCHESTRATOR: the listening + stage
// banners, the host's knock / stage-request / song-request lists, the crowd channel, the
// roster, and the share modes. The leaf pieces (StageBar / CrowdPanel / SocialCard / RequestList
// / ChatPanel) live in ./social/. See docs/social-layer.md → "Surface architecture (UI)".

export function SocialScreen({ room, onClose, onActivate }: { room: RoomState; onClose: () => void; onActivate?: () => void }) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
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

        {room.listeningTo && (
          <>
            <div className="listening-banner">
              <span className="listening-what">
                🎧 Listening to <b>@{room.listeningTo}</b>
              </span>
              <button className="listening-stop" onClick={room.tuneOut}>
                Stop
              </button>
            </div>
            <StageBar room={room} />
          </>
        )}

        {/* Crowd reactions + hype — wherever a broadcast is happening (you host one, or you've
            tuned into one). Everyone present can tap; the DJ reads the energy. */}
        {(room.roomPublic || room.listeningTo) && <CrowdPanel room={room} />}

        {/* Chat (F5) — in any session or broadcast you're part of. */}
        {(room.roomPublic || room.listeningTo || room.enabled) && <ChatPanel room={room} revealed={revealed} />}

        {!inSession ? (
          <p className="social-hint">Sign in under Profile, or open an invite link, to join a shared session.</p>
        ) : (
          <div className="social-body">
            {room.pending && (
              <div className="social-waiting">⏳ Waiting for the host to let you in…</div>
            )}
            {!online && <div className="social-offline">{room.status === "error" ? "Offline — retrying…" : "Connecting…"}</div>}

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

            {/* HOST: broadcast listeners raising a hand to step up to the decks (E3–E6). The
                host brings them up onto the deck they asked for (or overrides A/B), or declines. */}
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

            {/* HOST: the crowd-ranked song requests (F1 + F3). Read the top one, pull the
                track, dismiss it. Vote counts + ▲ live in the shared RequestList. */}
            {room.host && <RequestList room={room} host revealed={revealed} />}

            <div className="social-section-head">
              In the room{participants.length > 0 ? ` · ${participants.length}` : ""}
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

            {/* Own-session management is hidden while tuned into someone else's broadcast
                (you're a read-only listener there — the banner's Stop is the only action). */}
            <div className="social-foot" style={room.listeningTo ? { display: "none" } : undefined}>
              {/* Recordings (G1b): the host's own captured sets — Publish / rename / Discard.
                  Self-hides until the first set; auto-opens when a fresh draft lands. */}
              {!room.isGuest && room.signedIn && <RecordingsPanel setsRev={room.setsRev} />}

              {!room.joined ? (
                !online ? (
                  <button className="room-cta" disabled>
                    {room.status === "error" ? "Offline — retrying…" : "Connecting…"}
                  </button>
                ) : room.pending ? (
                  <button className="room-cta" disabled>Waiting for approval…</button>
                ) : sessionLive ? (
                  <button className="room-cta" onClick={joinSession} title={room.host ? "Join as a remote control — your master device keeps the audio" : "Join as a listener — the host can hand you the decks"}>
                    {room.host ? "Join as remote" : "Join session"}
                  </button>
                ) : (
                  <button className="room-cta" onClick={startSession}>Start session</button>
                )
              ) : (
                <button className="room-unlink" onClick={room.leave}>Leave session</button>
              )}

              {/* Two distinct ways to share a session, exposed side by side so the access
                  model is obvious: a CLOSED private invite (you approve each guest; they can
                  co-DJ) vs an OPEN public lobby (anyone at your @handle tunes in; listeners can
                  ask to step up to the decks). They're independent — you can run either or both. */}
              {!room.isGuest && room.signedIn && (
                <div className="share-modes">
                  <div className="social-section-head">Share this session</div>

                  {/* PRIVATE — invite specific people; they knock, you let them in. */}
                  <div className="share-mode private">
                    <div className="share-mode-head">
                      <span className="share-mode-title">🔒 Private invite</span>
                      <span className="share-mode-sub">A link for specific people. They knock, you approve — and they can take the decks.</span>
                    </div>
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
                  </div>

                  {/* PUBLIC — open the room to anyone at your @handle (the broadcast plane). */}
                  <div className={`share-mode public ${room.roomPublic ? "live" : ""}`}>
                    <div className="share-mode-head">
                      <span className="share-mode-title">
                        🌐 Public lobby{room.roomPublic && <span className="share-live-dot" aria-hidden="true"> ●</span>}
                      </span>
                      <span className="share-mode-sub">
                        Open to anyone at {room.user?.handle ? <>your <b>@{room.user.handle}</b></> : "your @handle"}. They tune in to listen and can ask to step up to the decks.
                      </span>
                    </div>
                    {room.user?.handle ? (
                      room.joined ? (
                        <>
                          <button
                            className={`broadcast-btn ${room.roomPublic ? "on" : ""}`}
                            onClick={() => room.goPublic(!room.roomPublic)}
                            title={room.roomPublic ? "Close the public lobby" : "Open this set to anyone at your @handle"}
                          >
                            {room.roomPublic ? "■ End broadcast" : "● Go live"}
                          </button>
                          {room.roomPublic && (
                            <span className="broadcast-status">
                              Live at <b>@{room.user.handle}</b> · {room.listenerCount} listening
                            </span>
                          )}
                          {room.roomPublic && (
                            <div className="gate-select" role="group" aria-label="How the crowd reaches the decks">
                              <span className="gate-label">Decks</span>
                              {([
                                { m: "request", label: "Request", title: "Listeners raise a hand; you approve" },
                                { m: "open", label: "Open", title: "Listeners grab any free deck instantly" },
                                { m: "closed", label: "Closed", title: "Only you (and private invitees) play" },
                              ] as const).map(({ m, label, title }) => (
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
                        </>
                      ) : (
                        <button className="broadcast-btn" disabled title="Start the session first">● Go live</button>
                      )
                    ) : (
                      <span className="broadcast-hint">Claim a @handle in Profile to open a public lobby.</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {room.error && <p className="room-err">{room.error}</p>}
      </div>
    </div>
  );
}
