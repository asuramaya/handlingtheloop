import { useEffect, useRef, useState } from "react";
import { heroState, type RoomState } from "@htl/room";
import { maskName, toggleRevealed, usePrivacyRevealed } from "@htl/privacy";
import type { PanelKey, PanelPlacement } from "@htl";
import { QRCode } from "./QRCode";
import { CenterResizeHandles, DockPlacementResizer, panelZIndex, useCenterZIndex } from "./DockResizer";
import { StageBar } from "./social/StageBar";
import { SelfSwitches, SocialCard } from "./social/SocialCard";
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

// ★ TABS, A FIXED TOP AND A FIXED FOOT (operator, 2026-11-11: "an eye sore… hard to understand at
// first glance… make a footer/header section for static elements and make room/chat 2 different
// tabs the way people/you are tabbed"). The old panel stacked status, chat and roster as cards in
// one long scroll, so the chat composer and the Leave button moved with whatever was above them,
// and the chat card wore two "CHAT" headings. Now:
//   • TOP (fixed): the title with a one-word status chip, the hero's action, anyone WAITING on the
//     host, and the Room | Chat tabs.
//   • BODY (the only thing that scrolls): the chosen tab.
//   • FOOT (fixed): THIS device: its Decks / Sound switches and Leave / Join.
type SessionTab = "room" | "chat";
let lastTab: SessionTab = "room"; // survives closing and reopening the panel

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
  dockMode?: PanelPlacement; // RESOLVED placement from App (never the raw setting) — "sheet" on a phone
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

  // ── Tabs + unread chat ─────────────────────────────────────────────────────────────────────
  const [tab, setTabState] = useState<SessionTab>(lastTab);
  const setTab = (t: SessionTab) => {
    lastTab = t;
    setTabState(t);
  };
  // Unread = lines that arrived while the Chat tab was not showing. Keyed on the last line SEEN
  // (the log is a sliding window, so a count would drift).
  const seenChatId = useRef<string | null>(room.chatLog.at(-1)?.id ?? null);
  const lastChatId = room.chatLog.at(-1)?.id ?? null;
  useEffect(() => {
    if (tab === "chat") seenChatId.current = lastChatId;
  }, [tab, lastChatId]);
  const seenIdx = seenChatId.current ? room.chatLog.findIndex((m) => m.id === seenChatId.current) : -1;
  const unreadChat = tab === "chat" ? 0 : seenChatId.current && seenIdx < 0 ? room.chatLog.length : room.chatLog.length - 1 - seenIdx;
  const chatOpen = crowdLive || participants.length > 1; // somebody to talk to

  // ── The one-word status, for the title row ──────────────────────────────────────────────────
  const statusChip: { label: string; tone: string } =
    state === "offline"
      ? { label: room.status === "error" ? "Offline" : "Connecting", tone: "dim" }
      : state === "pending"
        ? { label: "Knocking", tone: "accent" }
        : state === "listening"
          ? { label: "Listening", tone: "live" }
          : state === "live"
            ? { label: "Live", tone: "live" }
            : room.joined
              ? { label: "Private", tone: "accent" }
              : { label: "Not in a session", tone: "dim" };

  const me = room.peers.find((p) => p.id === room.you) ?? null;

  // Conditionally mounted by App (only exists while open) — mount itself IS "just opened".
  const centerZ = useCenterZIndex(dockMode, true);
  const zIndex = panelZIndex(dockMode, "session", panelOrder, centerZ);

  return (
    <div className={`modal-backdrop dock-${dockMode}`} style={{ zIndex }} onPointerDown={onClose}>
      <DockPlacementResizer mode={dockMode} />
      <div className="panel social-screen" onPointerDown={(e) => e.stopPropagation()}>
        {dockMode === "center" && <CenterResizeHandles panelKey="session" />}

        {/* ═════════════ TOP — fixed ═════════════ */}
        <div className="session-top">
          <div className="settings-head">
            <h2>{room.isGuest ? "Guest session" : "Session"}</h2>
            {inSession && <span className={`session-status ${statusChip.tone}`}>{statusChip.label}</span>}
            <button
              className={`room-eye ${revealed ? "on" : ""}`}
              onClick={toggleRevealed}
              aria-label={revealed ? "Hide names" : "Reveal names"}
              title={revealed ? "Hide names" : "Reveal names"}
            >
              {revealed ? "🙈" : "👁"}
            </button>
          </div>

          {room.engineStale && (
            <button className="engine-stale-note" onClick={() => location.reload()}>
              ⚠ This set was made on a different app version — refresh to hear it faithfully.
            </button>
          )}

          {inSession && (
            <>
              {/* THE HERO, slimmed to what it says and the one thing to do about it. */}
              {state === "pending" && <div className="session-line">Waiting for the host to let you in…</div>}

              {state === "listening" && (
                <div className="room-hero listening">
                  <div className="hero-row">
                    <span className="hero-title">🎧 <b>@{room.listeningTo}</b></span>
                    <button className="hero-stop" onClick={room.tuneOut}>Stop listening</button>
                  </div>
                  <StageBar room={room} />
                </div>
              )}

              {state === "live" && (
                <div className="room-hero live">
                  <div className="hero-row">
                    <span className="hero-title">
                      <span className="hero-dot" aria-hidden="true">●</span>
                      {room.user?.handle ? <span className="hero-handle"> @{room.user.handle}</span> : " On air"}
                    </span>
                    <span className="hero-listeners">{room.listenerCount} listening</span>
                    <button className="hero-stop" onClick={() => room.goPublic(false)}>End</button>
                  </div>
                  {room.host && (
                    <div className="hero-row hero-gate">
                      <span className="settings-label">
                        Decks
                        <InfoDot
                          text="How the crowd reaches your decks. Request: a listener raises a hand and you approve each one. Open: any listener can take a free deck instantly. Closed: only you and the people you invited privately can play."
                          label="Decks access"
                        />
                      </span>
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
                    </div>
                  )}
                </div>
              )}

              {state === "idle" && (
                <div className="session-line">
                  {room.user?.handle ? (
                    <>
                      <span>
                        Only people you invite can join.
                        <InfoDot
                          text={`Go live opens @${room.user.handle} to anyone: they tune in to listen and can ask to step up to the decks.`}
                          label="Go live"
                        />
                      </span>
                      <button className="hero-golive small" onClick={goLive} disabled={!online}>
                        ● Go live
                      </button>
                    </>
                  ) : (
                    <span>Only people you invite can join. To go live, claim a @handle under People ▸ You.</span>
                  )}
                </div>
              )}

              {/* WAITING — every person BLOCKED on you. It stays in the fixed top, above the tabs:
                  someone waiting outranks whichever tab you happen to be reading. */}
              {waiting > 0 && (
                <div className="session-waiting">
                  {knocks.map((p) => (
                    <div key={p.id} className="session-wait-row">
                      <span className="social-knock-ico" aria-hidden="true">{deviceIcon(p.kind)}</span>
                      <span className="session-wait-who">
                        <b>{revealed ? p.name : maskName(p.name)}</b> wants to join
                      </span>
                      <button className="hw-btn small primary" onClick={() => room.approve(p.id)}>Let in</button>
                      <button className="hw-btn small danger" onClick={() => room.deny(p.id)}>Deny</button>
                    </div>
                  ))}
                  {stageReqs.map((r) => (
                    <div key={r.id} className="session-wait-row">
                      <span className="social-knock-ico" aria-hidden="true">🎧</span>
                      <span className="session-wait-who">
                        <b>{revealed ? r.name : maskName(r.name)}</b> wants deck {r.deck}
                      </span>
                      <button className="hw-btn small primary" onClick={() => room.approveStage(r.id, r.deck)}>
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
                    </div>
                  ))}
                </div>
              )}

              {!room.isGuest && room.signedIn && <SetSavedPrompt setsRev={room.setsRev} />}

              <div className="settings-tabs session-tabs" role="tablist" aria-label="Session">
                <button role="tab" aria-selected={tab === "room"} className={`settings-tab ${tab === "room" ? "on" : ""}`} onClick={() => setTab("room")}>
                  Room
                  {participants.length > 0 && <span className="tab-count">{participants.length}</span>}
                </button>
                <button role="tab" aria-selected={tab === "chat"} className={`settings-tab ${tab === "chat" ? "on" : ""}`} onClick={() => setTab("chat")}>
                  {crowdLive ? "Crowd" : "Chat"}
                  {unreadChat > 0 && <span className="tab-badge">{unreadChat > 9 ? "9+" : unreadChat}</span>}
                </button>
              </div>
            </>
          )}
        </div>

        {/* ═════════════ BODY — the only scroller ═════════════ */}
        <div className={`settings-body session-body ${tab === "chat" && inSession ? "chat" : ""}`}>
          {!inSession ? (
            <p className="settings-note">Sign in under People ▸ You, or open an invite link, to join a shared session.</p>
          ) : tab === "room" ? (
            <>
              {room.listeningTo ? (
                <p className="settings-note">You're tuned in to @{room.listeningTo}'s broadcast. The decks and the people on them are theirs.</p>
              ) : (
                <ul className="social-roster">
                  {room.peers
                    .filter((p) => !p.pending)
                    .map((p) => (
                      <SocialCard key={p.id} room={room} p={p} revealed={revealed} onActivate={onActivate} selfActs={false} />
                    ))}
                  {others.length === 0 && !sessionLive && (
                    <li className="social-ghost">Open htl on another device on this account, or invite someone below.</li>
                  )}
                </ul>
              )}

              {/* INVITE — the narrower, deliberate door (Go live is the open one). */}
              {!room.isGuest && room.signedIn && !room.listeningTo && (
                <div className="settings-section session-invite">
                  <button className="settings-section-head as-toggle" onClick={() => setInviteOpen((o) => !o)} aria-expanded={inviteOpen}>
                    <span className="settings-label">Invite someone</span>
                    <span className="settings-head-note">{inviteOpen ? "▾" : "▸"}</span>
                  </button>
                  {inviteOpen && (
                    <>
                      <InviteFriends live={room.roomPublic} />
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
            </>
          ) : (
            <>
              {crowdLive && room.host && <RequestList room={room} host revealed={revealed} onQueue={onQueueRequest} />}
              {chatOpen ? (
                <ChatPanel room={room} revealed={revealed} fill />
              ) : (
                <p className="settings-note session-empty">Chat opens once someone else is in the session.</p>
              )}
            </>
          )}
        </div>

        {room.error && <p className="settings-note bad session-error">{room.error}</p>}

        {/* ═════════════ FOOT — fixed: THIS device ═════════════ */}
        {inSession && online && !room.listeningTo && (
          <div className="session-foot">
            <span className="session-foot-who">
              <span aria-hidden="true">{deviceIcon(me?.kind ?? "")}</span> This device
            </span>
            <span className="session-foot-acts">
              {room.joined && me && <SelfSwitches room={room} p={me} onActivate={onActivate} />}
              {room.joined ? (
                <button className="hw-btn small danger" onClick={room.leave}>Leave</button>
              ) : room.pending ? (
                <span className="settings-value">waiting…</span>
              ) : sessionLive ? (
                <button className="hw-btn small primary" onClick={joinSession}>{room.host ? "Join as remote" : "Join session"}</button>
              ) : room.isGuest ? (
                <button className="hw-btn small primary" onClick={joinSession}>Join session</button>
              ) : (
                <button className="hw-btn small primary" onClick={startSession}>Start a private session</button>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
