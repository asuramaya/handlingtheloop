// React binding for the shared session. Gates on sign-in (a session needs an account
// so it can be keyed + invited), owns the RoomClient lifecycle, and exposes the role
// model (joined / listening / controller) + the actions and the intent/state/tick
// channels used by the App-level sync wiring.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMe, announceRoom, closeRoom, saveSet, type AccountUser } from "../account";
import { RoomClient, deviceId, deviceName, joinCodeFromUrl, type RoomStatus } from "./client";
import type { Peer, Intent, TickDecks, DeckId, StageReq, StageGate, SongRequest, ChatMsg } from "./protocol";
export type { TickDecks } from "./protocol";

export interface RoomCallbacks {
  onIntent?: (intent: Intent, from: string) => void;
  onState?: (snapshot: unknown) => void;
  onAutomix?: (state: unknown) => void;
  onTick?: (decks: TickDecks) => void;
  onStemView?: (deck: DeckId, view: unknown) => void;
  onLyrics?: (deck: DeckId, videoId: string, lines: unknown, source: string) => void;
  onSettings?: (settings: unknown, updatedAt: number) => void; // a same-account device's settings → adopt (LWW)
  onKicked?: (reason?: string) => void;
}

export interface Invite {
  code: string;
  url: string;
}

export interface RoomState {
  enabled: boolean; // "in the session" = joined as a participant
  signedIn: boolean;
  user: AccountUser | null;
  status: RoomStatus;
  you: string;
  peers: Peer[];
  anchorId: string | null; // the playhead-clock device (invisible plumbing)
  isAnchor: boolean; // is THIS device the clock + snapshot authority?
  joined: boolean; // is THIS device a participant?
  pending: boolean; // is THIS device a guest knocking, awaiting the host's approval?
  listening: boolean; // is THIS device rendering its own audio stream?
  controlling: boolean; // is THIS device allowed to drive the decks?
  host: boolean; // is THIS device on the session-owner's account (vs a guest)?
  hostColor: string | null; // the host's account accent (hex) — the room "vibe" colour
  isGuest: boolean; // did I arrive via an invite (someone else's session)?
  roomPublic: boolean; // is the room OPEN to anonymous broadcast listeners?
  listenerCount: number; // size of the anonymous broadcast crowd
  engineStale: boolean; // D5: the room's reconstruction engine differs from ours → mix can't be trusted (refresh)
  goPublic: (on: boolean) => void; // HOST: open/close the broadcast plane (+ directory announce)
  listeningTo: string | null; // a host @handle if we've tuned into their public broadcast (else null)
  tuneIn: (handle: string) => void; // tune into a public room by @handle (read-only listener)
  tuneOut: () => void; // leave the broadcast, back to our own session
  // Floor → stage (E3–E6): a broadcast listener steps up to the decks, the host approves.
  stageRequests: StageReq[]; // HOST: listeners raising a hand to step up (approve/deny)
  onStage: boolean; // am I a stepped-up listener currently driving a deck?
  myDeck: DeckId | null; // the deck I hold while on stage (else null)
  myStageDeck: DeckId | null; // the deck I've REQUESTED while still on the floor (pending; else null)
  requestStage: (deck: DeckId) => void; // LISTENER: raise a hand for a deck (or grab it, in open mode)
  stepDown: () => void; // LISTENER: cancel a pending request, or step down off the decks
  approveStage: (to: string, deck: DeckId) => void; // HOST: bring a listener up onto a deck
  denyStage: (to: string) => void; // HOST: decline a request / send a stage DJ to the floor
  stageGate: StageGate; // how the crowd reaches the decks (request/open/closed)
  setStageGate: (mode: StageGate) => void; // HOST: set the gate mode
  // Crowd reactions (F4) + hype (F2).
  hype: number; // decaying crowd-energy level 0..1 (the meter)
  reactionTick: { counts: Record<string, number>; id: number }; // latest aggregated burst (id bumps on each non-empty frame → animate)
  react: (emoji: string) => void; // tap a reaction
  // Song requests (F1) + upvotes (F3).
  songRequests: SongRequest[]; // the crowd's asks, ranked by votes (everyone sees them now)
  votedRequests: Set<string>; // ids this device has already upvoted (to disable the ▲)
  requestSong: (text: string) => void; // LISTENER: ask the DJ for a song
  voteRequest: (id: string) => void; // upvote a request
  dismissRequest: (id: string) => void; // HOST: remove one request
  clearRequests: () => void; // HOST: clear all requests
  // Chat (F5) + moderation (L1).
  chatLog: ChatMsg[]; // the running chat (history + live)
  chatSlow: number; // slow-mode: <0 chat off, 0 normal, >0 N-second gate
  iAmMuted: boolean; // the host muted THIS device
  mutedDevices: Set<string>; // HOST: device ids currently muted (to flip the row mute⇄unmute)
  sendChat: (text: string) => void; // post a chat line
  setChatSlow: (seconds: number) => void; // HOST: set slow-mode / turn chat off
  muteDevice: (to: string, on: boolean) => void; // HOST: mute/unmute a device's chat
  banDevice: (to: string) => void; // HOST: ban a device (evict + block re-entry)
  error: string | null;
  client: RoomClient | null;
  join: () => void; // establish sync (listen on, control off) — guests knock first
  leave: () => void;
  setControl: (on: boolean) => void; // 🎛️ my OWN drive switch (independent of audio)
  setListening: (on: boolean) => void; // 🔊 my OWN sound switch (independent of control)
  grantControl: (to: string, on: boolean) => void; // HOST grants/revokes a device's control
  approve: (to: string) => void; // HOST lets a knocking guest in (the handshake)
  deny: (to: string) => void; // HOST turns a knocking guest away
  kick: (to: string) => void; // HOST removes a guest already in
  createInvite: () => Promise<Invite | null>;
  sendIntent: (intent: Intent) => void;
  sendTick: (decks: TickDecks) => void;
  publishState: (snapshot: unknown) => void;
  sendStemView: (deck: DeckId, view: unknown) => void;
  sendAutomix: (state: unknown) => void;
  sendLyrics: (deck: DeckId, videoId: string, lines: unknown, source: string) => void;
  sendSettings: (settings: unknown, updatedAt: number) => void; // broadcast my settings to my other devices
  requestState: () => void;
  refreshUser: () => void; // re-pull /api/me (e.g. after a handle claim) without reconnecting the socket
}

/** Account → friendly participant label (name, else email local-part, else device). */
function labelFor(user: AccountUser | null): string {
  if (user?.name) return user.name;
  if (user?.email) return user.email.split("@")[0];
  return deviceName();
}

/** A stable, anonymous guest label derived from this device's id (no account needed). */
function guestName(): string {
  const tail = deviceId().replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase() || "0000";
  return `Guest ${tail}`;
}

export interface NowPlaying {
  title: string;
  artist: string;
  videoId: string;
}

export function useRoom(cb: RoomCallbacks = {}, color?: string, nowPlaying?: NowPlaying | null): RoomState {
  const you = deviceId();
  // This device's account accent — sent at connect + on change (via the effect below) so
  // the room vibe + roster swatches sync instantly. Read through a ref at connect time.
  const colorRef = useRef(color);
  colorRef.current = color;
  // Capture any invite code ONCE at mount. Kept stable (not re-read from the URL) so that
  // stripping the code from the URL below — to stop a stale invite from pinning a signed-in
  // user away from their own session forever — doesn't flip `isGuest` and tear the socket down.
  const [joinCode] = useState(() => joinCodeFromUrl());
  const isGuest = !!joinCode;
  const [user, setUser] = useState<AccountUser | null>(null);
  const userId = user?.id ?? null; // socket lifecycle keys on this, not the object ref
  const [meLoaded, setMeLoaded] = useState(false);
  const [status, setStatus] = useState<RoomStatus>("offline");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roomPublic, setRoomPublic] = useState(false);
  const [listenerCount, setListenerCount] = useState(0);
  const [engineStale, setEngineStale] = useState(false);
  const listenerCountRef = useRef(0);
  listenerCountRef.current = listenerCount;
  // HOST: the pending floor→stage hand-raises. LISTENER (optimistic): the deck I asked for
  // while still on the floor — set on tap, cleared when the host brings me up (onStage) or
  // declines (the stage-self signal) or I cancel.
  const [stageRequests, setStageRequests] = useState<StageReq[]>([]);
  const [myStageDeck, setMyStageDeck] = useState<DeckId | null>(null);
  const [stageGate, setStageGateState] = useState<StageGate>("request");
  const [hype, setHype] = useState(0);
  const [reactionTick, setReactionTick] = useState<{ counts: Record<string, number>; id: number }>({ counts: {}, id: 0 });
  const [songRequests, setSongRequests] = useState<SongRequest[]>([]);
  const [votedRequests, setVotedRequests] = useState<Set<string>>(new Set());
  const [chatLog, setChatLog] = useState<ChatMsg[]>([]);
  const [chatSlow, setChatSlowState] = useState(0);
  const [iAmMuted, setIAmMuted] = useState(false);
  const [mutedDevices, setMutedDevices] = useState<Set<string>>(new Set());
  // Only the session OWNER (a host device) announces the room to the directory — a
  // listener/guest must NOT (anon → 401 spam; a signed-in guest would falsely register
  // its OWN room). Read through a ref so the heartbeat effect needn't depend on `host`
  // (which is derived below) and re-fire on every presence tick.
  const hostRef = useRef(false);
  // Current track (for the directory card), read through a ref so the heartbeat doesn't
  // re-fire on every render — a dedicated effect re-announces when the videoId changes.
  const nowPlayingRef = useRef(nowPlaying);
  nowPlayingRef.current = nowPlaying;
  // When set, we've TUNED INTO someone else's public room by @handle as a read-only
  // listener (instead of our own session). Anon-capable. null = our own session.
  const [listenHandle, setListenHandle] = useState<string | null>(null);
  const isPublicListener = !!listenHandle;
  const clientRef = useRef<RoomClient | null>(null);

  // Latest callbacks read via a ref so they can change (they close over engine /
  // setters) without tearing down and reconnecting the socket.
  const cbRef = useRef(cb);
  cbRef.current = cb;

  // Who's signed in (the session is account-scoped). Cheap one-shot; `meLoaded` lets the
  // socket effect wait for the verdict so we don't connect twice (anon → then signed-in).
  useEffect(() => {
    let alive = true;
    fetchMe()
      .then((m) => {
        if (alive) setUser(m.user);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setMeLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Open the socket once auth resolves: signed-in users always (their own session);
  // anonymous users ONLY when they arrived via an invite link (they join as a guest).
  useEffect(() => {
    if (!meLoaded) return;
    const tuning = !!listenHandle;
    const anonGuest = !user && isGuest;
    // Connect when: TUNING into a public room (anyone, incl. anonymous), OR signed in
    // (our own session), OR an anon invite guest. Else there's nothing to connect to.
    if (!tuning && !user && !anonGuest) return;
    const c = new RoomClient({
      name: user ? labelFor(user) : guestName(),
      joinCode: tuning ? undefined : (joinCode ?? undefined),
      listenHandle: tuning ? listenHandle : undefined,
      color: colorRef.current,
    });
    clientRef.current = c;
    c.on({
      status: setStatus,
      presence: setPeers,
      role: setAnchorId,
      error: setError,
      intent: (i, from) => cbRef.current.onIntent?.(i, from),
      state: (s) => cbRef.current.onState?.(s),
      automix: (s) => cbRef.current.onAutomix?.(s),
      tick: (d) => cbRef.current.onTick?.(d),
      stemview: (deck, view) => cbRef.current.onStemView?.(deck, view),
      lyrics: (deck, videoId, lines, source) => cbRef.current.onLyrics?.(deck, videoId, lines, source),
      settings: (s, updatedAt) => cbRef.current.onSettings?.(s, updatedAt),
      listeners: (count, isPublic) => {
        setListenerCount(count);
        setRoomPublic(isPublic);
      },
      stage: (reqs) => setStageRequests(reqs),
      stageGate: (mode) => setStageGateState(mode),
      engine: (stale) => setEngineStale(stale),
      // G1a: a broadcast ended → persist the captured recipe as a private draft
      // (capture-by-default; the host curates it later via the lifecycle card, G1b).
      setCaptured: (set) => void saveSet(set),
      // A step-up didn't go through (declined / deck taken / closed) — clear the optimistic
      // pending deck. The human reason rides a separate `error` the server sends alongside.
      stageSelf: () => setMyStageDeck(null),
      reactions: (counts, h) => {
        setHype(h);
        // Only bump the burst id on a non-empty frame, so the UI animates real taps — not the
        // empty decay frames the server keeps sending while hype falls back to zero.
        const total = Object.values(counts).reduce((s, n) => s + n, 0);
        if (total > 0) setReactionTick((t) => ({ counts, id: t.id + 1 }));
      },
      requests: (list) => setSongRequests(list),
      chat: (m) => setChatLog((l) => [...l.slice(-119), m]),
      chatHistory: (list) => setChatLog(list),
      chatSlow: (s) => setChatSlowState(s),
      muted: (on) => setIAmMuted(on),
      mutedList: (ids) => setMutedDevices(new Set(ids)),
      kicked: (reason) => cbRef.current.onKicked?.(reason),
    });
    c.connect();
    // A SIGNED-IN device consumes an invite code ONCE, then strips it from the URL so a
    // later reload returns to its OWN home session instead of staying pinned to the (maybe
    // stale) invited room — the bug that split a user's own devices into two rooms where
    // they never saw each other. Anonymous guests KEEP the code (it's their only way back);
    // the live guest session survives reconnects via the client's in-memory joinCode.
    if (!tuning && user && joinCode) {
      try {
        const u = new URL(location.href);
        u.searchParams.delete("join");
        history.replaceState(null, "", u.pathname + u.search + u.hash);
      } catch {
        /* history unavailable — harmless */
      }
    }
    return () => {
      c.close();
      clientRef.current = null;
      setPeers([]);
      setAnchorId(null);
      setStatus("offline");
      setError(null);
      setRoomPublic(false);
      setListenerCount(0);
      setStageRequests([]);
      setMyStageDeck(null);
      setStageGateState("request");
      setHype(0);
      setReactionTick({ counts: {}, id: 0 });
      setSongRequests([]);
      setVotedRequests(new Set());
      setChatLog([]);
      setChatSlowState(0);
      setIAmMuted(false);
      setMutedDevices(new Set());
    };
    // Keyed on userId (stable string), not the user object, so an identical /api/me
    // re-fetch never tears down + reopens the socket (which looked like a "drop").
    // listenHandle flips us between our own session and a tuned-in public room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meLoaded, userId, isGuest, listenHandle]);

  // Server-side rejections (e.g. a guest tapping a locked 🎛️) arrive as transient
  // notices — show them, then clear so the popup doesn't carry a stale warning (#10).
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // Actions are stable (they target the live client via a ref), so effects that
  // depend on them don't re-fire every render.
  const join = useCallback(() => clientRef.current?.join(), []);
  const leave = useCallback(() => clientRef.current?.leave(), []);
  const setControl = useCallback((on: boolean) => clientRef.current?.control(on), []);
  const setListening = useCallback((on: boolean) => clientRef.current?.listen(on), []);
  const grantControl = useCallback((to: string, on: boolean) => clientRef.current?.grant(to, on), []);
  const approve = useCallback((to: string) => clientRef.current?.approve(to), []);
  const deny = useCallback((to: string) => clientRef.current?.deny(to), []);
  const kick = useCallback((to: string) => clientRef.current?.kick(to), []);
  const sendIntent = useCallback((intent: Intent) => clientRef.current?.sendIntent(intent), []);
  const sendTick = useCallback((decks: TickDecks) => clientRef.current?.sendTick(decks), []);
  const publishState = useCallback((snapshot: unknown) => clientRef.current?.publishState(snapshot), []);
  const sendStemView = useCallback((deck: DeckId, view: unknown) => clientRef.current?.sendStemView(deck, view), []);
  const sendAutomix = useCallback((state: unknown) => clientRef.current?.sendAutomix(state), []);
  const sendSettings = useCallback((settings: unknown, updatedAt: number) => clientRef.current?.sendSettings(settings, updatedAt), []);
  const sendLyrics = useCallback((deck: DeckId, videoId: string, lines: unknown, source: string) => clientRef.current?.sendLyrics(deck, videoId, lines, source), []);
  const requestState = useCallback(() => clientRef.current?.requestState(), []);
  // Re-pull the signed-in account (handle/display name may have just changed). Keyed on
  // the same userId, so it updates `user` WITHOUT tearing down + reopening the socket.
  const refreshUser = useCallback(() => {
    fetchMe()
      // Dedupe: this fires on every Profile-dock close (to catch a handle claim), but
      // installing a fresh user object when nothing changed re-rendered the whole app a
      // beat later — the board's "double-jump" reflow. Keep the same ref when unchanged so
      // React bails the re-render (a real sign-in/out/claim still flows through).
      .then((m) => setUser((prev) => (JSON.stringify(prev) === JSON.stringify(m.user) ? prev : m.user)))
      .catch(() => {});
  }, []);
  // HOST: open/close the broadcast plane. Tells the DO (admits anon listeners) AND the
  // D1 directory shadow (so the room shows in "live now") — kept in sync here.
  const announce = useCallback(
    () => announceRoom({ listeners: listenerCountRef.current, nowPlaying: nowPlayingRef.current ?? undefined }),
    [],
  );
  const goPublic = useCallback(
    (on: boolean) => {
      clientRef.current?.goPublic(on);
      if (on) void announce();
      else void closeRoom();
    },
    [announce],
  );
  // Tune into a public room by @handle as a read-only listener (swaps our connection),
  // or tune back out to our own session. Accepts a bare or @-prefixed handle.
  const tuneIn = useCallback((handle: string) => setListenHandle(handle.replace(/^@/, "") || null), []);
  const tuneOut = useCallback(() => {
    setMyStageDeck(null);
    setListenHandle(null);
  }, []);
  // Floor → stage. requestStage is optimistic (the floor crowd gets no stage echo, so we
  // remember our own ask locally); stepDown covers both "cancel my pending request" and
  // "step off the decks" (one wire message — the server infers which from our state).
  const requestStage = useCallback((deck: DeckId) => {
    clientRef.current?.requestStage(deck);
    setMyStageDeck(deck);
  }, []);
  const stepDown = useCallback(() => {
    clientRef.current?.stepDown();
    setMyStageDeck(null);
  }, []);
  const approveStage = useCallback((to: string, deck: DeckId) => clientRef.current?.approveStage(to, deck), []);
  const denyStage = useCallback((to: string) => clientRef.current?.denyStage(to), []);
  const setStageGate = useCallback((mode: StageGate) => {
    clientRef.current?.setStageGate(mode);
    setStageGateState(mode); // optimistic — the presence echo confirms
  }, []);
  const react = useCallback((emoji: string) => clientRef.current?.react(emoji), []);
  const requestSong = useCallback((text: string) => clientRef.current?.requestSong(text), []);
  const voteRequest = useCallback((id: string) => {
    clientRef.current?.voteRequest(id);
    setVotedRequests((s) => (s.has(id) ? s : new Set(s).add(id))); // optimistic — disable the ▲
  }, []);
  const dismissRequest = useCallback((id: string) => clientRef.current?.dismissRequest(id), []);
  const clearRequests = useCallback(() => clientRef.current?.clearRequests(), []);
  const sendChat = useCallback((text: string) => clientRef.current?.sendChat(text), []);
  const setChatSlow = useCallback((seconds: number) => clientRef.current?.setChatSlow(seconds), []);
  const muteDevice = useCallback((to: string, on: boolean) => clientRef.current?.muteDevice(to, on), []);
  const banDevice = useCallback((to: string) => clientRef.current?.banDevice(to), []);
  // While public, heartbeat the directory (~30s) so `last_seen` stays fresh and the
  // listener count tracks; the room ages out of "live now" if this stops (host vanished).
  useEffect(() => {
    if (!roomPublic || !hostRef.current) return; // ONLY the host announces — never a listener/guest
    void announce();
    const t = setInterval(() => void announce(), 30_000);
    return () => clearInterval(t);
  }, [roomPublic, announce]);
  // Re-announce immediately when the now-playing track changes (so "Live now" cards keep up
  // between heartbeats). Keyed on the videoId so an unchanged object ref never re-fires.
  useEffect(() => {
    if (roomPublic && hostRef.current) void announce();
    // G1a: tag the recorded set's tracklist as the host's now-playing changes.
    if (roomPublic && hostRef.current && nowPlaying?.videoId) clientRef.current?.markTrack(nowPlaying);
  }, [nowPlaying?.videoId, roomPublic, announce]); // eslint-disable-line react-hooks/exhaustive-deps
  // Re-broadcast the accent whenever it changes (the user re-themed) so peers re-vibe live.
  useEffect(() => {
    if (color) clientRef.current?.setColor(color);
  }, [color]);
  const createInvite = useCallback(async (): Promise<Invite | null> => {
    try {
      const res = await fetch("/api/room/invite", { method: "POST", credentials: "same-origin" });
      if (!res.ok) return null;
      return (await res.json()) as Invite;
    } catch {
      return null;
    }
  }, []);

  // A TUNED-IN public listener is read-only and NOT in the roster, so derive its role
  // locally: it's joined + hearing the mix, never driving / host / anchor / pending. BUT
  // once the host brings it ON STAGE the server gives it a real roster row (pub→participant);
  // from then on trust that row over the listener defaults, even though listenHandle is still
  // set (the socket never changed — we just gained a seat). `floorListener` = on the floor,
  // not (yet) on the decks.
  const me = peers.find((p) => p.id === you);
  const floorListener = isPublicListener && !me;
  const joined = floorListener || (me?.joined ?? false);
  const pending = floorListener ? false : (me?.pending ?? false); // knocking guest, awaiting the host's handshake
  const listening = floorListener || (me?.listening ?? false); // muted-by-default model: no audio until 🔊
  const controlling = floorListener ? false : (me?.controlling ?? false);
  const host = floorListener ? false : (me?.host ?? false);
  hostRef.current = host; // gate the directory-announce heartbeat (above) to host devices only
  const onStage = me?.stage ?? false; // stepped up from the floor onto a deck
  const myDeck: DeckId | null = onStage ? (me?.decks === "A" ? "A" : me?.decks === "B" ? "B" : null) : null;
  // Once the host actually brings us up, the optimistic "pending" deck is resolved — clear it.
  // (Must sit AFTER `onStage` is declared — referencing it earlier is a TDZ crash on render.)
  useEffect(() => {
    if (onStage) setMyStageDeck(null);
  }, [onStage]);
  const isAnchor = !isPublicListener && anchorId !== null && anchorId === you;
  // The room's vibe colour = the host's accent. Prefer the anchor if it's a host device,
  // else any host peer with a colour set (the session owner's account colour).
  const hostColor =
    peers.find((p) => p.host && p.id === anchorId && p.color)?.color ??
    peers.find((p) => p.host && p.color)?.color ??
    null;

  return {
    enabled: joined,
    signedIn: !!user,
    user,
    status,
    you,
    peers,
    anchorId,
    isAnchor,
    joined,
    pending,
    listening,
    controlling,
    host,
    hostColor,
    isGuest,
    roomPublic,
    listenerCount,
    engineStale,
    goPublic,
    listeningTo: listenHandle,
    tuneIn,
    tuneOut,
    stageRequests,
    onStage,
    myDeck,
    myStageDeck,
    requestStage,
    stepDown,
    approveStage,
    denyStage,
    stageGate,
    setStageGate,
    hype,
    reactionTick,
    react,
    songRequests,
    votedRequests,
    requestSong,
    voteRequest,
    dismissRequest,
    clearRequests,
    chatLog,
    chatSlow,
    iAmMuted,
    mutedDevices,
    sendChat,
    setChatSlow,
    muteDevice,
    banDevice,
    error,
    client: clientRef.current,
    join,
    leave,
    setControl,
    setListening,
    grantControl,
    approve,
    deny,
    kick,
    createInvite,
    sendIntent,
    sendTick,
    publishState,
    sendStemView,
    sendAutomix,
    sendSettings,
    sendLyrics,
    requestState,
    refreshUser,
  };
}
