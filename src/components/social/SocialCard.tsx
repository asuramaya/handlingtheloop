import { useState } from "react";
import type { RoomState } from "@htl/room";
import { maskName } from "@htl/privacy";
import { ago, deviceIcon } from "./util";
import { RELATION_LABEL, relationOf } from "./relation";

// One roster row: who the device is, and the two facts that matter about it (does it drive the
// decks, does it play sound), with the controls that apply to it.
//
// ★ THE STATE IS THE CONTROL (operator, 2026-11-11: "these rows need a redesign so the narrow
// version is not so crammed and the wide version is not so barren"). A row used to show a chip
// row ("Decks · Muted") AND, on your own row, two icon buttons for the very same two facts, so
// the narrow panel carried four things for two states and the wide one left a gulf between them.
// Now each fact is ONE pill with an icon and a word: a button where you may change it (your own
// row; a guest's decks for the host), a plain pill where you may not. Wide, the pills sit on the
// right of the row; narrow, they drop under the name (a container query on the roster), so
// neither width crams or strands them. Timekeeper and "on stage" are badges beside the name, and
// the device kind and time in the session share one quiet meta line.
export function SocialCard({
  room,
  p,
  revealed,
  onActivate,
  friends,
}: {
  room: RoomState;
  p: RoomState["peers"][number];
  revealed: boolean;
  onActivate?: () => void;
  /** Lower-cased @handles of my friends (mutual follows), to mark them. */
  friends: ReadonlySet<string>;
}) {
  const isSelf = p.id === room.you;
  const isGuest = !p.host;
  const me = room.peers.find((x) => x.id === room.you) ?? null;
  const rel = relationOf(p, me, room.you, friends);
  // My own devices all read "You"; the meta line says which device (and "this device").
  const label = rel === "you" ? "You" : isGuest || revealed ? p.name : maskName(p.name);

  // Who may change what on this row.
  // ★ MY OTHER DEVICES ARE MINE TO SWITCH (operator, 2026-11-11: "I should be able to control
  // deck/sound on my devices, right now only from the device itself"). A device on my account is
  // switched by asking it to press its own switch (room.setDevice → self-set), so its own rules hold.
  const myOther = rel === "you" && !isSelf;
  const canSelfDrive = isSelf && (room.host || p.controlling);
  const canDriveMine = myOther && room.host; // the host's devices may all drive; a guest's need a grant
  const canModerate = room.host && !isSelf && isGuest; // host over OTHER guests
  const deckBtn = p.joined && (canSelfDrive || canDriveMine || (canModerate && !p.stage));
  const soundBtn = p.joined && (isSelf || myOther);
  // A guest's row unfolds (tap it) to show what the host can do to them, instead of an inline ✕.
  const [open, setOpen] = useState(false);

  const deckLabel = p.stage && (p.decks === "A" || p.decks === "B") ? `Deck ${p.decks}` : "Decks";
  const onDecks = () => {
    if (isSelf) room.setControl(!p.controlling);
    else if (myOther) room.setDevice(p.id, { control: !p.controlling });
    else room.grantControl(p.id, !p.controlling);
  };
  const onSound = () => {
    if (myOther) return room.setDevice(p.id, { listen: !p.listening });
    if (!p.listening) onActivate?.();
    room.setListening(!p.listening);
  };

  const meta = [p.kind || null, isSelf && rel === "you" && room.peers.some((x) => x.id !== p.id && relationOf(x, me, room.you, friends) === "you") ? "this device" : null, p.joined ? (p.joinedAt > 0 ? ago(p.joinedAt) : null) : "not in the session"].filter(Boolean).join(" · ");

  const deckTitle = myOther
    ? p.controlling
      ? "Stop this device driving the decks"
      : "Let this device drive the decks"
    : isSelf
    ? canSelfDrive
      ? p.controlling
        ? "Stop driving the decks from this device"
        : "Drive the decks from this device"
      : "The host hands you the decks"
    : canModerate
      ? p.controlling
        ? "Take the decks back"
        : "Hand them the decks"
      : p.controlling
        ? "Drives the decks"
        : "Follows the decks, cannot drive them";
  const soundTitle = isSelf
    ? p.listening
      ? "Mute the mix on this device"
      : "Hear the mix on this device"
    : myOther
      ? p.listening
        ? "Mute the mix on that device"
        : "Play the mix on that device"
      : p.listening
        ? "Plays the mix out loud"
        : "Follows silently";

  return (
    <li className={`social-card rel-${rel} ${p.joined ? "in" : ""} ${isSelf ? "self" : ""} ${canModerate ? "can-open" : ""} ${open ? "open" : ""}`}>
      <span className="social-card-ico" aria-hidden="true">
        {deviceIcon(p.kind)}
      </span>
      <div
        className="social-card-main"
        {...(canModerate
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": open,
              title: open ? "Hide actions" : "Actions",
              onClick: () => setOpen((o) => !o),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((o) => !o);
                }
              },
            }
          : {})}
      >
        <div className="social-card-top">
          <span className="social-card-name">{label}</span>
          <span className={`rel-tag ${rel}`}>{RELATION_LABEL[rel]}</span>
          {p.stage && <span className="room-badge stage">on stage</span>}
          {p.anchor && (
            <span className="room-badge clock" title="Everyone's playback follows this device">
              timekeeper
            </span>
          )}
        </div>
        {meta && <div className="social-card-meta">{meta}</div>}
      </div>
      {p.joined && (
        <div className="social-card-pills">
          {deckBtn ? (
            <button className={`peer-pill ${p.controlling ? "on" : ""}`} onClick={onDecks} aria-pressed={p.controlling} title={deckTitle}>
              <span aria-hidden="true">🎛️</span>
              {deckLabel}
            </button>
          ) : (
            <span className={`peer-pill static ${p.controlling ? "on" : ""}`} title={deckTitle}>
              <span aria-hidden="true">🎛️</span>
              {deckLabel}
            </span>
          )}
          {soundBtn ? (
            <button className={`peer-pill ${p.listening ? "on" : ""}`} onClick={onSound} aria-pressed={p.listening} title={soundTitle}>
              <span aria-hidden="true">{p.listening ? "🔊" : "🔇"}</span>
              {p.listening ? "Sound" : "Muted"}
            </button>
          ) : (
            <span className={`peer-pill static ${p.listening ? "on" : ""}`} title={soundTitle}>
              <span aria-hidden="true">{p.listening ? "🔊" : "🔇"}</span>
              {p.listening ? "Sound" : "Muted"}
            </span>
          )}
        </div>
      )}
      {canModerate && open && (
        <div className="social-card-actions">
          {p.stage && (
            <button className="hw-btn small" onClick={() => room.denyStage(p.id)} title="They keep listening">
              Send back to the crowd
            </button>
          )}
          <button className="hw-btn small danger" onClick={() => room.kick(p.id)}>
            Remove from session
          </button>
        </div>
      )}
    </li>
  );
}
