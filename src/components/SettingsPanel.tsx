import { useState } from "react";
import { ACCENT_PRESETS, type Settings, getYtAuth, setYtAuth, clearYtAuth, hasYtAuth } from "@htl";

interface SettingsPanelProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}

// Modal popover holding all user customization (accent colors, glow, tempo
// range) plus YouTube access (the user's own session, to pass the bot challenge)
// and the privacy notice that explains the trade-off.
export function SettingsPanel({ settings, onChange, onClose }: SettingsPanelProps) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const [cookie, setCookie] = useState(() => getYtAuth().cookie ?? "");
  const [connected, setConnected] = useState(hasYtAuth());
  const [showPrivacy, setShowPrivacy] = useState(false);

  const connect = () => {
    const c = cookie.trim();
    setYtAuth({ cookie: c || undefined });
    setConnected(!!c);
  };
  const disconnect = () => {
    clearYtAuth();
    setCookie("");
    setConnected(false);
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="settings-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="mini x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <Swatches label="Deck A color" value={settings.accentA} onPick={(c) => set({ accentA: c })} />
        <Swatches label="Deck B color" value={settings.accentB} onPick={(c) => set({ accentB: c })} />

        <div className="settings-row">
          <span className="settings-label">Neon glow</span>
          <button
            className={`toggle ${settings.glow ? "on" : ""}`}
            onClick={() => set({ glow: !settings.glow })}
            role="switch"
            aria-checked={settings.glow}
          >
            <span className="toggle-knob" />
          </button>
        </div>

        {/* YouTube access — the user's own session to pass the bot challenge */}
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">
              YouTube access
              <span className={`yt-status ${connected ? "on" : ""}`}>{connected ? "● connected" : "○ not connected"}</span>
            </span>
            <button className="link-btn" onClick={() => setShowPrivacy((v) => !v)}>
              {showPrivacy ? "hide" : "how & privacy"}
            </button>
          </div>
          <p className="settings-hint">
            YouTube blocks our server's IP with a “confirm you're not a bot” check, so new tracks need your own session.
            Paste your <strong>youtube.com cookie</strong> (from a <em>Get&nbsp;cookies.txt</em> extension, or DevTools →
            Network → any request → Cookie header) to load with your account.
          </p>
          <textarea
            className="yt-cookie"
            placeholder="Paste your youtube.com Cookie header here…"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            spellCheck={false}
            rows={3}
          />
          <div className="yt-actions">
            <button className="hw-btn small" onClick={connect} disabled={!cookie.trim()}>
              Connect
            </button>
            <button className="hw-btn small" onClick={disconnect} disabled={!connected}>
              Disconnect
            </button>
          </div>

          {showPrivacy && (
            <div className="privacy">
              <h3>How this works &amp; your privacy</h3>
              <p>
                <strong>The compromise.</strong> This app runs entirely on one Cloudflare Worker plus your browser — there's
                no separate backend. YouTube increasingly blocks requests from datacenter IPs (like the Worker's) with a
                bot challenge. To load a track that isn't already cached, the Worker needs credentials that YouTube trusts:
                your signed-in <strong>cookie</strong> (or a browser-minted visitor/PO token).
              </p>
              <ul>
                <li>
                  Your cookie is stored <strong>only in this browser</strong> (localStorage) and is sent <strong>only to
                  this site's own Worker</strong>, which forwards it to YouTube to resolve the stream. It is{" "}
                  <strong>never stored on the server</strong>, logged, or shared with anyone else.
                </li>
                <li>
                  While connected, YouTube sees those requests as <strong>your account</strong>, from the Worker's IP. Treat
                  it like signing in: only use an account you're comfortable using this way, and Disconnect to remove the
                  cookie at any time.
                </li>
                <li>
                  Resolved audio is cached (by video id) so a track only hits YouTube once; that cached audio is shared
                  across users, but <strong>your cookie is not</strong>.
                </li>
                <li>
                  This is intended for non-copyrighted / cleared material and is subject to YouTube's Terms of Service. You
                  are responsible for what you load.
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Swatches({ label, value, onPick }: { label: string; value: string; onPick: (c: string) => void }) {
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <div className="swatches">
        {ACCENT_PRESETS.map((c) => (
          <button
            key={c}
            className={`swatch ${c.toLowerCase() === value.toLowerCase() ? "on" : ""}`}
            style={{ background: c }}
            onClick={() => onPick(c)}
            aria-label={c}
          />
        ))}
        <label className="swatch custom" style={{ background: value }}>
          <input type="color" value={value} onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
    </div>
  );
}
