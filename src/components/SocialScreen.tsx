import { useEffect, useRef, useState } from "react";
import { fetchFriendsOnline } from "@htl/account";
import { heroState, type RoomState } from "@htl/room";
import { maskName, setRevealed, usePrivacyRevealed } from "@htl/privacy";
import type { PanelKey, PanelPlacement } from "@htl";
import { QRCode } from "./QRCode";
import { CenterResizeHandles, DockPlacementResizer, panelZIndex, useCenterZIndex } from "./DockResizer";
import { StageBar } from "./social/StageBar";
import { SocialCard } from "./social/SocialCard";
import { relationOf, type Relation } from "./social/relation";
import { RequestList } from "./social/RequestList";
import { ChatPanel } from "./social/ChatPanel";
import { InviteFriends } from "./social/InviteFriends";
import { SetSavedPrompt } from "./social/SetSavedPrompt";
import { InfoDot } from "./settings/InfoDot";
import { ToggleRow } from "./settings/ControlsTab";
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
type SessionTab = "room" | "chat" | "settings";
let lastTab: SessionTab = "room"; // survives closing and reopening the panel
let lastInviteUrl: string | null = null; // one link per session: reopen shows it, never re-creates

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
  const [inviteUrl, setInviteUrlState] = useState<string | null>(lastInviteUrl);
  const setInviteUrl = (u: string | null) => {
    lastInviteUrl = u;
    setInviteUrlState(u);
  };
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false); // the invite card, up from the footer
  // ★ SESSION SETTINGS, a view of its own (operator, 2026-11-11: "a dedicated settings panel for
  // social"): names, who can chat, and whether guests may pass the invite on. The chat controls
  // under the composer and the names button in the footer both read as clutter where they were.

  // The invite sheet's drag-to-dismiss.
  const [sheetDrag, setSheetDrag] = useState(0);
  const sheetStart = useRef<number | null>(null);
  // My friends' @handles (mutual follows), to colour their rows. Anyone in the session is online,
  // so the online list is the whole answer. One fetch per open, refreshed when the roster grows.
  const [friends, setFriends] = useState<ReadonlySet<string>>(new Set());
  const rosterSize = room.peers.length;
  useEffect(() => {
    if (!room.signedIn) return;
    let alive = true;
    fetchFriendsOnline()
      .then((f) => alive && setFriends(new Set(f.map((x) => x.handle.toLowerCase()))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [room.signedIn, rosterSize]);
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
    if (inv) setInviteUrl(inv.url);
  }
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  // A guest invites with the HOST's link, when the host allows it (Session ▸ Settings).
  const guestShareUrl = room.isGuest && room.guestInvite ? `${location.origin}/?join=${room.guestInvite}` : null;
  const canInvite = (!room.isGuest && room.signedIn) || !!guestShareUrl;
  const shownInviteUrl = guestShareUrl ?? inviteUrl;
  const setGuestsInvite = async (on: boolean) => {
    if (!on) return room.setGuestInvite("");
    const inv = await room.createInvite();
    if (inv) {
      setInviteUrl(inv.url);
      room.setGuestInvite(inv.code);
    }
  };
  const shareLink = async (url: string) => {
    try {
      await navigator.share({ title: "Join my session", url });
    } catch {
      /* dismissed / unsupported: the copy button is right beside it */
    }
  };
  // Opening the card makes the link if there is none yet: one tap to a QR, not two.
  const openInvite = () => {
    const next = !inviteOpen;
    setInviteOpen(next);
    if (next && !shownInviteUrl && !inviting) void makeInvite();
  };

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
  // ★ SETTINGS IS A TAB (operator, 2026-11-11: the gear "looks awkward dead in the middle… make it
  // behave and look more like the room/chat tabs"): a narrow third tab on the same strip.
  const settingsOpen = tab === "settings";
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
            {inSession && state === "idle" && room.user?.handle && (
              <button
                className="hero-golive small"
                onClick={goLive}
                disabled={!online}
                title={`Open @${room.user.handle} to anyone: they tune in to listen and can ask to step up to the decks.`}
              >
                ● Go live
              </button>
            )}
            {inSession && <span className={`session-status ${statusChip.tone}`}>{statusChip.label}</span>}
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
                <button
                  role="tab"
                  aria-selected={settingsOpen}
                  aria-label="Session settings"
                  title="Session settings"
                  className={`settings-tab session-tab-gear ${settingsOpen ? "on" : ""}`}
                  onClick={() => {
                    setInviteOpen(false);
                    setTab("settings");
                  }}
                >
                  ⚙
                </button>
              </div>
            </>
          )}
        </div>

        {/* ═════════════ BODY — the only scroller ═════════════ */}
        <div className={`settings-body session-body ${tab === "chat" && inSession && !settingsOpen ? "chat" : ""}`}>
          {!inSession ? (
            <p className="settings-note">Sign in under People ▸ You, or open an invite link, to join a shared session.</p>
          ) : settingsOpen ? (
            <div className="session-settings">
              <div className="settings-section">
                <ToggleRow
                  label="Show names"
                  info="Names of the people and devices in the session. Turn this off while you stream or share your screen: names show as a first letter and dots. Remembered on this device."
                  on={revealed}
                  onToggle={() => setRevealed(!revealed)}
                />
              </div>
              {/* Public / private: the broadcast (Go live) as a switch, beside the other room rules. */}
              {room.host && !room.isGuest && room.signedIn && (
                <div className="settings-section">
                  {room.user?.handle ? (
                    <ToggleRow
                      label="Public"
                      info={`Public opens @${room.user.handle} to anyone: they tune in to listen and can ask to step up to the decks. Private: only people you invite.`}
                      on={room.roomPublic}
                      onToggle={() => (room.roomPublic ? room.goPublic(false) : goLive())}
                    />
                  ) : (
                    <div className="settings-row">
                      <span className="settings-label">Public</span>
                      <span className="settings-value">Claim a @handle under People ▸ You first</span>
                    </div>
                  )}
                </div>
              )}
              {room.host && (
                <div className="settings-section">
                  <div className="settings-section-head">
                    <span className="settings-label">Chat</span>
                  </div>
                  <div className="settings-row">
                    <span className="settings-label">
                      Chat
                      <InfoDot text="Off closes the chat. Slow mode lets each person post one line per 5 or 15 seconds." label="Chat" />
                    </span>
                    <span className="settings-control">
                      <span className="seg-group">
                        {([
                          { v: -1, l: "Off" },
                          { v: 0, l: "On" },
                          { v: 5, l: "Slow 5s" },
                          { v: 15, l: "Slow 15s" },
                        ] as const).map((o) => (
                          <button
                            key={o.v}
                            className={`hw-btn small ${room.chatSlow === o.v ? "on" : ""}`}
                            onClick={() => room.setChatSlow(o.v)}
                            aria-pressed={room.chatSlow === o.v}
                          >
                            {o.l}
                          </button>
                        ))}
                      </span>
                    </span>
                  </div>
                  <ToggleRow
                    label="Followers only"
                    info="Only people who follow you (and anyone on your decks) can post."
                    on={room.chatFollowers}
                    onToggle={() => room.setChatFollowers(!room.chatFollowers)}
                  />
                </div>
              )}
              {room.host && !room.isGuest && room.signedIn && (
                <div className="settings-section">
                  <div className="settings-section-head">
                    <span className="settings-label">Invites</span>
                  </div>
                  <ToggleRow
                    label="Guests can invite"
                    info="Guests get the Invite button with your session's link, so they can bring friends. Anyone arriving still knocks, and you let them in."
                    on={!!room.guestInvite}
                    onToggle={() => void setGuestsInvite(!room.guestInvite)}
                  />
                </div>
              )}
            </div>
          ) : tab === "room" ? (
            <>
              {room.listeningTo ? (
                <p className="settings-note">You're tuned in to @{room.listeningTo}'s broadcast. The decks and the people on them are theirs.</p>
              ) : (
                <ul className="social-roster">
                  {/* ★ THIS DEVICE FIRST, THEN SECTIONS (operator, 2026-11-11): you, the host, friends,
                      guests, the crowd, each under a small label. */}
                  {(() => {
                    const me = room.peers.find((x) => x.id === room.you) ?? null;
                    const order: Relation[] = ["you", "host", "friend", "guest", "crowd"];
                    const title: Record<Relation, string> = { you: "You", host: "Host", friend: "Friends", guest: "Guests", crowd: "From the crowd" };
                    const rows = room.peers.filter((p) => !p.pending);
                    const groups = order
                      .map((rel) => ({
                        rel,
                        list: rows
                          .filter((p) => relationOf(p, me, room.you, friends) === rel)
                          .sort((a, b) => (a.id === room.you ? -1 : b.id === room.you ? 1 : (a.joinedAt || 0) - (b.joinedAt || 0))),
                      }))
                      .filter((g) => g.list.length > 0);
                    return groups.map((g) => (
                      <li key={g.rel} className="social-roster-group">
                        {groups.length > 1 && <div className={`social-roster-sep rel-${g.rel}`}>{title[g.rel]}</div>}
                        <ul className="social-roster-list">
                          {g.list.map((p) => (
                            <SocialCard key={p.id} room={room} p={p} revealed={revealed} onActivate={onActivate} friends={friends} />
                          ))}
                        </ul>
                      </li>
                    ));
                  })()}
                  {others.length === 0 && !sessionLive && (
                    <li className="social-ghost">Open htl on another device on this account, or invite someone below.</li>
                  )}
                </ul>
              )}

              {/* Friends who are on right now, one tap to invite (absent when nobody is). */}
              {!room.isGuest && room.signedIn && !room.listeningTo && <InviteFriends live={room.roomPublic} quiet />}
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

        {/* ═════════════ INVITE SHEET — slides up from the bottom; drag it down (or tap outside) to close ═════════════ */}
        {inviteOpen && inSession && canInvite && online && (
          <>
            <div className="session-sheet-scrim" onPointerDown={() => setInviteOpen(false)} />
            <div
              className="session-invite-card"
              role="dialog"
              aria-label="Invite to this session"
              style={sheetDrag ? { transform: `translateY(${sheetDrag}px)`, transition: "none" } : undefined}
            >
              <div
                className="session-sheet-grab"
                onPointerDown={(e) => {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  sheetStart.current = e.clientY;
                }}
                onPointerMove={(e) => {
                  if (sheetStart.current == null) return;
                  setSheetDrag(Math.max(0, e.clientY - sheetStart.current));
                }}
                onPointerUp={() => {
                  if (sheetStart.current == null) return;
                  sheetStart.current = null;
                  if (sheetDrag > 80) setInviteOpen(false);
                  setSheetDrag(0);
                }}
                onPointerCancel={() => {
                  sheetStart.current = null;
                  setSheetDrag(0);
                }}
                aria-hidden="true"
              >
                <span className="session-sheet-handle" />
              </div>

                {shownInviteUrl ? (
                  <>
                    <QRCode value={shownInviteUrl} size={208} className="room-invite-qr" />
                    {/* The link IS the copy control: the whole field copies, the glyph says so. */}
                    <div className="session-invite-field">
                      <button type="button" className="session-invite-url" onClick={() => copyLink(shownInviteUrl)} title="Copy link">
                        {shownInviteUrl.replace(/^https?:\/\//, "")}
                      </button>
                      <button
                        type="button"
                        className={`session-invite-glyph ${copied ? "done" : ""}`}
                        onClick={() => copyLink(shownInviteUrl)}
                        aria-label={copied ? "Copied" : "Copy link"}
                        title={copied ? "Copied" : "Copy link"}
                      >
                        {copied ? "✓" : "⧉"}
                      </button>
                      {canShare && (
                        <button type="button" className="session-invite-glyph" onClick={() => shareLink(shownInviteUrl)} aria-label="Share" title="Share">
                          ⇪
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="session-invite-making">
                    <button className="hw-btn small primary" onClick={makeInvite} disabled={inviting}>
                      {inviting ? "Making a link…" : "Create link"}
                    </button>
                  </div>
                )}
            </div>
          </>
        )}
        {/* ═════════════ FOOT — fixed: invite + leave ═════════════ */}
        {inSession && online && !room.listeningTo && (
          <div className="session-foot">
            <span className="session-foot-left">
              {canInvite && (
                <button className={`hw-btn small ${inviteOpen ? "on" : ""}`} onClick={openInvite} aria-expanded={inviteOpen}>
                  ＋ Invite
                </button>
              )}
            </span>
            {room.joined ? (
              <button className="hw-btn small danger" onClick={room.leave}>Leave session</button>
            ) : room.pending ? (
              <span className="settings-value">waiting…</span>
            ) : sessionLive ? (
              <button className="hw-btn small primary" onClick={joinSession}>{room.host ? "Join as remote" : "Join session"}</button>
            ) : room.isGuest ? (
              <button className="hw-btn small primary" onClick={joinSession}>Join session</button>
            ) : (
              <button className="hw-btn small primary" onClick={startSession}>Start a private session</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
