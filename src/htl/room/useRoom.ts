// React binding for the shared session. Gates on sign-in (a session needs an account
// so it can be keyed + invited), owns the RoomClient lifecycle, and exposes the role
// model (joined / listening / controller) + the actions and the intent/state/tick
// channels used by the App-level sync wiring.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMe, type AccountUser } from "../account";
import { RoomClient, deviceId, deviceName, joinCodeFromUrl, type RoomStatus } from "./client";
import type { Peer, Intent, TickDecks } from "./protocol";
export type { TickDecks } from "./protocol";

export interface RoomCallbacks {
  onIntent?: (intent: Intent, from: string) => void;
  onState?: (snapshot: unknown) => void;
  onTick?: (decks: TickDecks) => void;
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
  listening: boolean; // is THIS device rendering its own audio stream?
  controlling: boolean; // is THIS device allowed to drive the decks?
  host: boolean; // is THIS device on the session-owner's account (vs a guest)?
  isGuest: boolean; // did I arrive via an invite (someone else's session)?
  error: string | null;
  client: RoomClient | null;
  join: () => void; // establish sync (listen on, control off)
  leave: () => void;
  setControl: (on: boolean) => void; // 🎛️ my OWN drive switch (independent of audio)
  setListening: (on: boolean) => void; // 🔊 my OWN sound switch (independent of control)
  grantControl: (to: string, on: boolean) => void; // HOST grants/revokes a device's control
  createInvite: () => Promise<Invite | null>;
  sendIntent: (intent: Intent) => void;
  sendTick: (decks: TickDecks) => void;
  publishState: (snapshot: unknown) => void;
  requestState: () => void;
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

export function useRoom(cb: RoomCallbacks = {}): RoomState {
  const you = deviceId();
  const isGuest = !!joinCodeFromUrl();
  const [user, setUser] = useState<AccountUser | null>(null);
  const userId = user?.id ?? null; // socket lifecycle keys on this, not the object ref
  const [meLoaded, setMeLoaded] = useState(false);
  const [status, setStatus] = useState<RoomStatus>("offline");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    const anonGuest = !user && isGuest;
    if (!user && !anonGuest) return;
    const c = new RoomClient({ name: user ? labelFor(user) : guestName() });
    clientRef.current = c;
    c.on({
      status: setStatus,
      presence: setPeers,
      role: setAnchorId,
      error: setError,
      intent: (i, from) => cbRef.current.onIntent?.(i, from),
      state: (s) => cbRef.current.onState?.(s),
      tick: (d) => cbRef.current.onTick?.(d),
    });
    c.connect();
    return () => {
      c.close();
      clientRef.current = null;
      setPeers([]);
      setAnchorId(null);
      setStatus("offline");
      setError(null);
    };
    // Keyed on userId (stable string), not the user object, so an identical /api/me
    // re-fetch never tears down + reopens the socket (which looked like a "drop").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meLoaded, userId, isGuest]);

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
  const sendIntent = useCallback((intent: Intent) => clientRef.current?.sendIntent(intent), []);
  const sendTick = useCallback((decks: TickDecks) => clientRef.current?.sendTick(decks), []);
  const publishState = useCallback((snapshot: unknown) => clientRef.current?.publishState(snapshot), []);
  const requestState = useCallback(() => clientRef.current?.requestState(), []);
  const createInvite = useCallback(async (): Promise<Invite | null> => {
    try {
      const res = await fetch("/api/room/invite", { method: "POST", credentials: "same-origin" });
      if (!res.ok) return null;
      return (await res.json()) as Invite;
    } catch {
      return null;
    }
  }, []);

  const me = peers.find((p) => p.id === you);
  const joined = me?.joined ?? false;
  const listening = me?.listening ?? true;
  const controlling = me?.controlling ?? false;
  const host = me?.host ?? false;
  const isAnchor = anchorId !== null && anchorId === you;

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
    listening,
    controlling,
    host,
    isGuest,
    error,
    client: clientRef.current,
    join,
    leave,
    setControl,
    setListening,
    grantControl,
    createInvite,
    sendIntent,
    sendTick,
    publishState,
    requestState,
  };
}
