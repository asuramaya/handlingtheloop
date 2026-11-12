import { type ReactNode, useRef, useState } from "react";
import { QRCode } from "../QRCode";

// A LINK AS A BOTTOM SHEET: slides up over the panel with a QR and the link, dismissed by
// dragging its handle down or tapping outside. Session's invite and People's Share profile are
// the same thing (a link someone else should open), so they are one sheet. Tapping the QR or
// the link copies it; ⇪ hands it to the system share sheet where there is one.
export function LinkSheet({
  url,
  label,
  shareTitle,
  onClose,
  pending,
}: {
  url: string | null;
  label: string;
  shareTitle: string;
  onClose: () => void;
  /** Shown instead of the QR while there is no link yet (e.g. "Create link"). */
  pending?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async (u: string) => {
    try {
      await navigator.clipboard.writeText(u);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — link + QR shown for manual copy/scan */
    }
  };
  const share = async (u: string) => {
    try {
      await navigator.share({ title: shareTitle, url: u });
    } catch {
      /* dismissed / unsupported: the copy button is right beside it */
    }
  };

  return (
    <>
      <div className="session-sheet-scrim" onPointerDown={onClose} />
      <div
        className="session-invite-card"
        role="dialog"
        aria-label={label}
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
      >
        <div
          className="session-sheet-grab"
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            start.current = e.clientY;
          }}
          onPointerMove={(e) => {
            if (start.current == null) return;
            setDrag(Math.max(0, e.clientY - start.current));
          }}
          onPointerUp={() => {
            if (start.current == null) return;
            start.current = null;
            if (drag > 80) onClose();
            setDrag(0);
          }}
          onPointerCancel={() => {
            start.current = null;
            setDrag(0);
          }}
          aria-hidden="true"
        >
          <span className="session-sheet-handle" />
        </div>

        {url ? (
          <>
            {/* The QR copies the link too: a tap on it is the obvious "give me this". */}
            <button type="button" className={`session-qr-copy ${copied ? "done" : ""}`} onClick={() => copy(url)} title="Copy link" aria-label="Copy link">
              <QRCode value={url} size={208} className="room-invite-qr" />
              {copied && <span className="session-qr-copied">Copied</span>}
            </button>
            {/* The link IS the copy control: the whole field copies, the glyph says so. */}
            <div className="session-invite-field">
              <button type="button" className="session-invite-url" onClick={() => copy(url)} title="Copy link">
                {url.replace(/^https?:\/\//, "")}
              </button>
              <button
                type="button"
                className={`session-invite-glyph ${copied ? "done" : ""}`}
                onClick={() => copy(url)}
                aria-label={copied ? "Copied" : "Copy link"}
                title={copied ? "Copied" : "Copy link"}
              >
                {copied ? "✓" : "⧉"}
              </button>
              {canShare && (
                <button type="button" className="session-invite-glyph" onClick={() => share(url)} aria-label="Share" title="Share">
                  ⇪
                </button>
              )}
            </div>
          </>
        ) : (
          pending
        )}
      </div>
    </>
  );
}
