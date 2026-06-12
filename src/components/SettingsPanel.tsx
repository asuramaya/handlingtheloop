import { useEffect, useState } from "react";
import {
  contrastWarnings,
  type Settings,
  type StretchQuality,
  STRETCH_PRESETS,
  STEM_MODELS,
  getStemModel,
  modelSupport,
  isMobileDevice,
  fetchStemManifest,
  hasStemsLocal,
  probeWebGPU,
  webGpuAdapterInfo,
  isGpuBlocked,
  unblockGpu,
  isUntestedGpuPlatform,
  readStemTrace,
  clearStemTrace,
  formatStemTrace,
  type StemModel,
} from "@htl";
import {
  type Me,
  fetchMe,
  startGoogleSignIn,
  startSpotifyConnect,
  logout as accountLogout,
  disconnectService,
} from "@htl/account";
import type { StemStatus } from "../App";
import { KeyMap } from "./KeyHelp";
import { maskName, maskEmail, toggleRevealed, usePrivacyRevealed } from "@htl/privacy";

interface SettingsPanelProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
  loadedVideoIds?: string[]; // tracks currently on the decks (for per-model cache state)
  stemStatus?: Record<"A" | "B", StemStatus | null>; // live per-deck separation status/errors
  onReanalyze?: (modelId: string) => void; // force a fresh separation of the loaded track(s)
  onGpuReenable?: () => void; // user opted to re-enable GPU after a crash auto-disabled it
}

// What each model can do on THIS device, as a short badge for the picker.
function supportBadge(m: StemModel): { text: string; cls: string } {
  switch (modelSupport(m)) {
    case "instant":
      return { text: "Instant", cls: "ok" };
    case "runs":
      // demucs on the CPU backend runs everywhere but is SLOW — set the expectation.
      if (m.tier === "cpu")
        return { text: `Runs here (slow) · ${m.sizeMB} MB`, cls: "warn" };
      return { text: isMobileDevice() ? `Runs on phone · ${m.sizeMB} MB` : `Runs here · ${m.sizeMB} MB`, cls: "ok" };
    case "needs-gpu":
      // On a phone it's gated for memory; on desktop it just needs WebGPU enabled.
      return { text: isMobileDevice() ? "Desktop GPU only" : "Enable WebGPU to run here", cls: "warn" };
    case "blocked":
      return { text: "Disabled — crashed here", cls: "warn" };
    default:
      return { text: "Desktop separates", cls: "warn" };
  }
}

type Tab = "color" | "deck" | "keys" | "audio" | "stems" | "accounts" | "debug" | "about";
const TABS: { key: Tab; label: string }[] = [
  { key: "color", label: "Color" },
  { key: "deck", label: "Deck" },
  { key: "keys", label: "Keys" },
  { key: "audio", label: "Audio Engine" },
  { key: "stems", label: "Stems" },
  { key: "accounts", label: "Accounts" },
  { key: "debug", label: "Debug" },
  { key: "about", label: "About" },
];

// The customisable theme colours — each pill opens the colour picker directly.
type ColorKey =
  | "accentA"
  | "accentB"
  | "bgColor"
  | "textColor"
  | "borderColor"
  | "selectorColor"
  | "loopColor"
  | "markerColor"
  | "shiftColor"
  | "stripColor"
  | "stemDrumsColor"
  | "stemBassColor"
  | "stemVocalsColor"
  | "stemOtherColor";
const COLOR_TARGETS: { key: ColorKey; label: string }[] = [
  { key: "accentA", label: "Deck A" },
  { key: "accentB", label: "Deck B" },
  { key: "bgColor", label: "Background" },
  { key: "textColor", label: "Text" },
  { key: "borderColor", label: "Border" },
  { key: "selectorColor", label: "Selector" },
  { key: "loopColor", label: "Loops" },
  { key: "markerColor", label: "Markers" },
  { key: "shiftColor", label: "Accents" },
  { key: "stripColor", label: "Strip" },
  { key: "stemDrumsColor", label: "Drums" },
  { key: "stemBassColor", label: "Bass" },
  { key: "stemVocalsColor", label: "Vocals" },
  { key: "stemOtherColor", label: "Inst" },
];

// HSL → #rrggbb (h 0–360, s/l 0–100).
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
const randHue = () => Math.floor(Math.random() * 360);
const randIn = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const vividHex = () => hslToHex(randHue(), randIn(78, 100), randIn(55, 66));

// Whacky-but-usable random theme: vivid accents, a dark base, light text.
function randomTheme(): Pick<Settings, ColorKey> {
  return {
    accentA: vividHex(),
    accentB: vividHex(),
    bgColor: hslToHex(randHue(), randIn(25, 70), randIn(5, 12)),
    textColor: hslToHex(randHue(), randIn(8, 35), randIn(86, 96)),
    borderColor: hslToHex(randHue(), randIn(40, 80), randIn(22, 38)),
    selectorColor: hslToHex(randHue(), randIn(0, 20), randIn(90, 100)),
    loopColor: vividHex(),
    markerColor: vividHex(),
    shiftColor: vividHex(),
    stripColor: vividHex(),
    stemDrumsColor: vividHex(),
    stemBassColor: vividHex(),
    stemVocalsColor: vividHex(),
    stemOtherColor: vividHex(),
  };
}

// Pure black/white monochrome roll: flip a coin for which of text / background is
// black and which is white, with vivid random accents popping over the mono base.
function randomMono(): Pick<Settings, ColorKey> {
  const darkBase = Math.random() < 0.5; // true = black bg + white text
  const bg = darkBase ? "#000000" : "#ffffff";
  const text = darkBase ? "#ffffff" : "#000000";
  return {
    accentA: vividHex(),
    accentB: vividHex(),
    bgColor: bg,
    textColor: text,
    borderColor: darkBase ? "#2a2a2a" : "#cfcfcf",
    selectorColor: text,
    loopColor: vividHex(),
    markerColor: vividHex(),
    shiftColor: vividHex(),
    stripColor: vividHex(), // vivid waveform popping over the mono base
    // Vivid, DISTINCT per-stem colours so the quad lanes stay readable over mono.
    stemDrumsColor: vividHex(),
    stemBassColor: vividHex(),
    stemVocalsColor: vividHex(),
    stemOtherColor: vividHex(),
  };
}

// Settings modal, organised into tabs: Color (theme), Deck (feel), Accounts
// (sign-in + streaming cookie), Info (about), FAQ (how it works & privacy).
export function SettingsPanel({
  settings,
  onChange,
  onClose,
  loadedVideoIds = [],
  stemStatus,
  onReanalyze,
  onGpuReenable,
}: SettingsPanelProps) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const [tab, setTab] = useState<Tab>("color");
  const revealed = usePrivacyRevealed();

  // Per-model cache state for the tracks currently on the decks: a model is
  // "cached" (usable on ANY device, incl. phones) if every loaded track already
  // has its four stems in R2. Probed when the Stems tab is open.
  const [cachedModels, setCachedModels] = useState<Record<string, boolean>>({});
  const [traceTick, setTraceTick] = useState(0); // bump to re-read the separation trace
  const loadedKey = loadedVideoIds.join(",");
  // Refresh badges once the real WebGPU-adapter probe resolves (so GPU models flip
  // to "Runs here" the moment WebGPU is actually available).
  const [, setGpuProbed] = useState(false);
  useEffect(() => {
    probeWebGPU().then(() => setGpuProbed(true));
  }, []);
  // A model is "cached for the loaded track(s)" if EVERY loaded track has its stems
  // either on local disk (instant) OR complete in the shared R2 cache. We check
  // local FIRST (cheap, and it's what the "loaded from disk" status reflects) and
  // only hit the network when local misses. The result is NOT blanked on tab/track
  // switches — it persists and is overwritten when the fresh probe resolves, so the
  // badge doesn't flicker. Re-probes when the loaded tracks change OR a separation
  // finishes (a deck reaching a terminal cached/ready/promoted state).
  const doneKey = (["A", "B"] as const)
    .map((d) => {
      const p = stemStatus?.[d]?.phase;
      return p === "ready" || p === "cached" || p === "promoted" ? `${d}:${stemStatus?.[d]?.src ?? ""}` : "";
    })
    .join("|");
  useEffect(() => {
    if (loadedVideoIds.length === 0) {
      setCachedModels({});
      return;
    }
    let cancelled = false;
    (async () => {
      const out: Record<string, boolean> = {};
      for (const m of STEM_MODELS) {
        if (m.kind === "dsp") continue;
        const checks = await Promise.all(
          loadedVideoIds.map(async (v) => {
            if (await hasStemsLocal(v, m.id)) return true;
            const man = await fetchStemManifest(v, m.id).catch(() => null);
            return !!man?.complete;
          }),
        );
        out[m.id] = checks.length > 0 && checks.every(Boolean);
      }
      if (!cancelled) setCachedModels(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey, doneKey]);

  // htl account (server-side session via /api/me).
  const [me, setMe] = useState<Me | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const refreshMe = async () => {
    setMeLoading(true);
    try {
      setMe(await fetchMe());
    } finally {
      setMeLoading(false);
    }
  };

  useEffect(() => {
    refreshMe();
  }, []);

  const signOut = async () => {
    await accountLogout();
    await refreshMe();
  };
  const disconnect = async (provider: "google" | "spotify") => {
    await disconnectService(provider);
    await refreshMe();
  };

  const signedIn = !!me?.user;
  const hasSpotify = !!me?.connections.includes("spotify");
  const connected = signedIn;

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="panel settings-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="mini x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="settings-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`settings-tab ${tab === t.key ? "on" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === "color" && (
            <>
              {/* Each pill IS the colour picker — tap to open the OS wheel. */}
              <div className="color-targets">
                {COLOR_TARGETS.map((t) => {
                  // Strip defaults to "" (= follow deck accent); show accent A then.
                  const value = settings[t.key] || settings.accentA;
                  return (
                    <label key={t.key} className="color-target" title={`${t.label} — ${value}`}>
                      <span className="color-target-dot" style={{ background: value }} />
                      {t.label}
                      <input type="color" value={value} onChange={(e) => set({ [t.key]: e.target.value } as Partial<Settings>)} />
                    </label>
                  );
                })}
                <button className="color-target color-random" onClick={() => set(randomTheme())} title="Roll a random theme">
                  🎲 Random
                </button>
                <button
                  className="color-target color-random"
                  onClick={() => set(randomMono())}
                  title="Roll a pure black/white theme (random which is text vs background)"
                >
                  ⬛⬜ Mono
                </button>
              </div>

              {/* Collision detection: warn only when text/border can't be read. */}
              {(() => {
                const warns = contrastWarnings(settings);
                return warns.length ? (
                  <div className="color-warnings">
                    {warns.map((w) => (
                      <div key={w} className="color-warning">
                        <span className="color-warning-ico">⚠</span> {w}
                      </div>
                    ))}
                  </div>
                ) : null;
              })()}

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
            </>
          )}

          {tab === "deck" && (
            <div className="settings-section">
              <div className="settings-section-head">
                <span className="settings-label">Jog feel</span>
                <button className="link-btn" onClick={() => set({ jogWeight: 0.4, jogDrag: 0.4 })}>
                  reset
                </button>
              </div>
              <Slider
                label="Weight"
                hint={settings.jogWeight < 0.2 ? "feather" : settings.jogWeight > 0.7 ? "heavy" : "balanced"}
                value={settings.jogWeight}
                onChange={(v) => set({ jogWeight: v })}
              />
              <Slider
                label="Drag"
                hint={settings.jogDrag < 0.2 ? "long glide" : settings.jogDrag > 0.7 ? "quick stop" : "balanced"}
                value={settings.jogDrag}
                onChange={(v) => set({ jogDrag: v })}
              />
              <p className="settings-hint">
                Weight is the platter's inertia (how it spins up and coasts); Drag is how quickly a fling brakes to a
                stop. Scrub the waveform to feel the difference.
              </p>
            </div>
          )}

          {tab === "keys" && (
            <div className="settings-section">
              <p className="settings-hint">
                The keys drive the <strong>focused</strong> deck — press <kbd className="kbd-chip">Tab</kbd> to switch
                decks (the focused one is ringed). Hold or latch <kbd className="kbd-chip">Shift</kbd> for the alt action
                shown after “⇧”.
              </p>
              <div className="settings-row">
                <span className="settings-label">On-button hints</span>
                <button
                  className={`toggle ${settings.keyHints ? "on" : ""}`}
                  onClick={() => set({ keyHints: !settings.keyHints })}
                  role="switch"
                  aria-checked={settings.keyHints}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
              <p className="settings-hint">Show each button's shortcut in its corner (desktop only).</p>
              <KeyMap bindings={settings.keyBindings} onChange={(keyBindings) => set({ keyBindings })} />
            </div>
          )}

          {tab === "audio" && (
            <div className="settings-section">
              <div className="settings-section-head">
                <span className="settings-label">Stretch engine quality</span>
              </div>
              <div className="seg">
                {(Object.keys(STRETCH_PRESETS) as StretchQuality[]).map((q) => (
                  <button
                    key={q}
                    className={`seg-btn ${settings.stretchQuality === q ? "on" : ""}`}
                    onClick={() => set({ stretchQuality: q })}
                  >
                    {STRETCH_PRESETS[q].label}
                  </button>
                ))}
              </div>
              <p className="settings-hint">
                {STRETCH_PRESETS[settings.stretchQuality].blurb} <br />
                <span className="muted">
                  ~{STRETCH_PRESETS[settings.stretchQuality].latencyMs} ms latency · grain{" "}
                  {STRETCH_PRESETS[settings.stretchQuality].frame}
                </span>
              </p>
              <p className="settings-hint">
                The unified <strong>tempo + key</strong> engine. It time-stretches in the time domain (WSOLA) so beats
                stay crisp, then resamples for pitch — tempo and key are fully independent, with no “underwater” smear.
                Affects key-lock, the tempo fader, and the KEY pitch shift on both decks.
              </p>
            </div>
          )}

          {tab === "stems" && (
            <>
              {isGpuBlocked() && (
                <div className="stem-blocked-banner">
                  <span>
                    GPU stem separation crashed last time and was <strong>disabled</strong> to stop a crash loop. CPU
                    models and cached results still work.
                  </span>
                  <button
                    className="link-btn"
                    onClick={() => {
                      unblockGpu();
                      onGpuReenable?.();
                    }}
                  >
                    Re-enable GPU
                  </button>
                </div>
              )}

              {(stemStatus?.A || stemStatus?.B) && (
                <div className="settings-section">
                  <div className="settings-section-head">
                    <span className="settings-label">Status</span>
                  </div>
                  {(["A", "B"] as const).map((d) => {
                    const st = stemStatus?.[d];
                    if (!st) return null;
                    return (
                      <div key={d} className={`stem-status-row ${st.phase}`}>
                        <span className="stem-status-deck">{d}</span>
                        <span className="stem-status-detail">{st.detail}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">Stem separation</span>
                </div>
                <div className="stem-models">
                  {STEM_MODELS
                    // Hide demucs-GPU on phones (WebGPU OOM-crashes Safari). demucs-CPU
                    // stays — on mobile it separates WINDOWED so it fits in memory.
                    .filter((m) => !(isMobileDevice() && m.tier === "gpu"))
                    .map((m) => {
                    const sup = modelSupport(m);
                    const badge = supportBadge(m);
                    const cached = cachedModels[m.id];
                    // Disabled after a crash → not selectable (cached results still load).
                    // Untested on this browser (e.g. Firefox) → dimmed + warned, but still
                    // selectable; the crash guard auto-disables it if it does crash.
                    const blocked = sup === "blocked" && !cached;
                    const untested = m.tier === "gpu" && sup === "runs" && isUntestedGpuPlatform();
                    return (
                      <button
                        key={m.id}
                        className={`stem-model ${settings.stemModel === m.id ? "on" : ""} ${blocked ? "blocked" : ""} ${
                          untested ? "untested" : ""
                        }`}
                        disabled={blocked}
                        onClick={() => !blocked && set({ stemModel: m.id })}
                      >
                        <span className="stem-model-label">
                          {m.label}
                          {m.kind !== "dsp" && <span className={`stem-badge ${badge.cls}`}>{badge.text}</span>}
                          {untested && <span className="stem-badge warn">Untested here — may crash</span>}
                          {cached && <span className="stem-badge cached">✓ cached for loaded track</span>}
                        </span>
                        <span className="stem-model-note">{m.note}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Re-analyze the loaded track(s) with the SELECTED model — force a
                    fresh on-device separation, overwriting any cached result. Only
                    enabled when the selected model is neural, this device can run it,
                    and a track is loaded. */}
                {(() => {
                  const sel = getStemModel(settings.stemModel);
                  if (sel.kind === "dsp") return null;
                  const canReanalyze = modelSupport(sel) === "runs" && loadedVideoIds.length > 0 && !!onReanalyze;
                  return (
                    <button
                      className="stem-reanalyze"
                      disabled={!canReanalyze}
                      onClick={() => canReanalyze && onReanalyze?.(sel.id)}
                      title={
                        loadedVideoIds.length === 0
                          ? "Load a track first"
                          : modelSupport(sel) !== "runs"
                            ? `${sel.label} can't be separated on this device`
                            : `Re-run ${sel.label} on the loaded track(s), overwriting the cached stems`
                      }
                    >
                      ↻ Re-analyze loaded track{loadedVideoIds.length > 1 ? "s" : ""} with {sel.label}
                    </button>
                  );
                })()}
                {(() => {
                  // What hardware the SELECTED model runs separation on:
                  //   • gpu tier (demucs WebGPU) → GPU; show the actual adapter name if known.
                  //   • cpu / light / dsp → CPU (ORT wasm / DSP filter).
                  // Note both demucs variants share arch "demucs-core" — only the GPU
                  // one is tier "gpu", so gate on TIER, not arch (the CPU one is wasm).
                  // GPU availability comes from modelSupport ("runs" = usable here),
                  // NOT from the adapter name (Firefox often blanks it for privacy).
                  const sel = getStemModel(settings.stemModel);
                  const gpu = sel.tier === "gpu";
                  const sup = modelSupport(sel);
                  const gpuAvail = gpu && sup === "runs";
                  const adapter = webGpuAdapterInfo();
                  const kind = gpu ? (gpuAvail ? "gpu" : "none") : "cpu";
                  const text = gpu
                    ? gpuAvail
                      ? adapter || (isMobileDevice() ? "WebGPU (experimental)" : "WebGPU")
                      : sup === "blocked"
                        ? "Disabled after a crash — re-enable above, or use a CPU model / cached result"
                        : "WebGPU not available here — pick a CPU model, or use a cached result"
                    : sel.kind === "dsp"
                      ? "DSP filter (instant)"
                      : "Neural · ORT WebAssembly";
                  return (
                    <div className={`stem-device ${kind}`}>
                      <span className="stem-device-tag">{gpu ? "GPU" : "CPU"}</span>
                      <span className="stem-device-text">{text}</span>
                    </div>
                  );
                })()}
              </div>
            </>
          )}

          {tab === "accounts" && (
            <>
              <div className="settings-section-head">
                <span className="settings-label">
                  Account &amp; sync
                  <span className={`yt-status ${connected ? "on" : ""}`}>
                    {signedIn ? "● signed in" : "○ not connected"}
                  </span>
                </span>
              </div>

              {/* htl account — Google sign-in + connected services. Accounts are
                  PLAYLIST-ONLY; streaming is always anonymous (no cookie/credential). */}
              <div className="yt-sub">
                <div className="yt-sub-head">
                  htl account <span className="yt-sub-note">connect YouTube / Spotify to sync your playlists</span>
                </div>
                {meLoading ? (
                  <p className="settings-hint">Checking…</p>
                ) : signedIn ? (
                  <>
                    <div className="acct-profile">
                      {me?.user?.avatar && (
                        <img className={`acct-avatar ${revealed ? "" : "private"}`} src={me.user.avatar} alt="" />
                      )}
                      <div className="acct-id">
                        <div className="acct-name">
                          {me?.user?.name ? (revealed ? me.user.name : maskName(me.user.name)) : "Signed in"}
                        </div>
                        {me?.user?.email && <div className="acct-email">{revealed ? me.user.email : maskEmail(me.user.email)}</div>}
                      </div>
                      <button
                        className={`room-eye ${revealed ? "on" : ""}`}
                        onClick={toggleRevealed}
                        title={revealed ? "Hide name & email (streaming-safe)" : "Reveal name & email"}
                        aria-label={revealed ? "Hide name and email" : "Reveal name and email"}
                      >
                        {revealed ? "🙈" : "👁"}
                      </button>
                      <button className="hw-btn small" onClick={signOut}>
                        Sign out
                      </button>
                    </div>
                    <div className="conn-list">
                      <ConnRow label="YouTube" connected note="via Google" onAction={() => disconnect("google")} actionLabel="Disconnect" />
                      <ConnRow
                        label="Spotify"
                        connected={hasSpotify}
                        onAction={() => (hasSpotify ? disconnect("spotify") : startSpotifyConnect())}
                        actionLabel={hasSpotify ? "Disconnect" : "Connect"}
                      />
                    </div>
                  </>
                ) : (
                  <div className="yt-actions">
                    <button className="hw-btn signin" onClick={startGoogleSignIn}>
                      Sign in with Google
                    </button>
                  </div>
                )}
              </div>

            </>
          )}

          {tab === "debug" && (
            <>
              {/* On-device separation crash trace — survives a tab OOM-kill (synchronous
                  localStorage), so after a crash + reload this shows the LAST step it
                  reached. The only way to debug an iPhone Safari crash without a Mac. */}
              {(() => {
                const trace = readStemTrace();
                if (!trace.length) {
                  return (
                    <div className="settings-section">
                      <p className="settings-hint">No separation trace yet. Run a stem split and it'll be recorded here.</p>
                    </div>
                  );
                }
                return (
                  <div className="settings-section">
                    <div className="settings-section-head">
                      <span className="settings-label">Separation trace (diagnostics)</span>
                      <button
                        className="link-btn"
                        onClick={() => {
                          clearStemTrace();
                          setTraceTick((n) => n + 1);
                        }}
                      >
                        Clear
                      </button>
                    </div>
                    <pre className="stem-trace" key={traceTick}>
                      {formatStemTrace(trace)}
                    </pre>
                    <div className="settings-hint">
                      Last line = where it stopped. If it ends mid-run after a crash, that step is the culprit.
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {tab === "about" && (
            <div className="settings-info">
              <h3>Handling The Loop</h3>
              <p className="settings-hint">
                A serverless, in-browser DJ rig: two decks, waveform scrubbing with real vinyl feel, beat-matched mixing,
                native key/BPM detection, and on-device stem separation — with YouTube (plus your Spotify / YouTube
                playlists) as your crate. Everything runs in this tab plus one Cloudflare Worker. No install, and nothing
                to sign up for to start.
              </p>
              <ul className="info-list">
                <li>Search YouTube or paste a video / playlist link to pull tracks in.</li>
                <li>Drag the waveform to scrub; the jog feel is tunable in the Deck tab.</li>
                <li>Audio, stems, and analysis are cached and shared, so a track is fetched and separated once.</li>
              </ul>

              <details className="policy">
                <summary>Privacy — what's collected, what isn't</summary>
                <p className="settings-hint">
                  <strong>htl works with no account and no sign-in</strong> — by default it's anonymous. There are no ad
                  networks, no third-party analytics profiles, and nothing is sold. Your library, decks, cue points, and
                  settings live in <em>this browser</em> (localStorage), not on our servers.
                </p>
                <ul className="info-list">
                  <li>
                    <strong>Audio proxy.</strong> A browser can't fetch YouTube's audio servers directly (they block
                    cross-origin requests), so our Cloudflare Worker resolves the stream server-side and re-serves the raw
                    bytes to your browser, which decodes them locally for the decks. Your browser only ever talks to our
                    own Worker (same origin) — never an ad/tracking host.
                  </li>
                  <li>
                    <strong>Streaming cookie (optional).</strong> The only way to load brand-new tracks past YouTube's
                    bot check is a youtube.com cookie. It's held <strong>in memory for this browser session only</strong>
                    — never written to disk, trimmed to the minimum cookies, auto-expiring, and gone when you close the
                    tab. It's sent only to our Worker, which forwards it to YouTube and <strong>never stores, logs, or
                    shares it</strong>.
                  </li>
                  <li>
                    <strong>Google sign-in token (optional).</strong> Used only to browse <em>your</em> YouTube
                    playlists. It stays in this browser and is browse-only (it can't fetch audio). Revoke anytime at
                    Google's “Third-party access”.
                  </li>
                  <li>
                    <strong>htl account (optional).</strong> If you sign in to sync playlists, your session is an
                    httpOnly cookie and your Google / Spotify tokens are <strong>encrypted at rest</strong> in our
                    database, used only to read and write the playlists you choose to sync. Disconnect any service from
                    the Accounts tab.
                  </li>
                </ul>
              </details>

              <details className="policy">
                <summary>The shared community cache &amp; why it's built this way</summary>
                <p className="settings-hint">
                  Resolved audio, separated stems, and analysis (BPM, key, beatgrid) are cached by <em>YouTube video
                  id</em> and shared across everyone — so a track is fetched from YouTube once and separated once, then
                  loads instantly for the next person. Stem separation is heavy, so pooling the result is what makes it
                  free and fast for phones that could never run the models themselves.
                </p>
                <p className="settings-hint">
                  This cache is keyed only by the public video id. It carries <strong>no personal data</strong>, isn't
                  linked to who loaded a track, and never contains anyone's credentials. The audio bytes are already
                  reachable by anyone who knows the public video id; the cache just avoids re-fetching and re-computing.
                </p>
              </details>

              <details className="policy">
                <summary>Terms &amp; legal</summary>
                <ul className="info-list">
                  <li>
                    htl is an open-source tool for live mixing and for music-information research (tempo / key / stem
                    analysis). The full source is public on GitHub.
                  </li>
                  <li>
                    Loading content is subject to YouTube's Terms of Service. <strong>You are responsible for what you
                    load</strong> and for holding the rights to use it. It's intended for material you own, that's
                    cleared, or that's otherwise non-infringing.
                  </li>
                  <li>
                    Stems and analysis are machine-derived from the source audio and provided as-is, for study and
                    personal mixing — not as a licensed distribution of the underlying recordings.
                  </li>
                  <li>
                    Provided “as is”, without warranty of any kind. Use at your own risk.
                  </li>
                  <li>
                    A rights holder who wants a track removed from the shared cache can{" "}
                    <a href="https://github.com/asuramaya/handlingtheloop/issues" target="_blank" rel="noreferrer noopener">
                      open a request on GitHub
                    </a>{" "}
                    and it will be purged.
                  </li>
                </ul>
              </details>

              <h3 className="about-faq-head">FAQ</h3>
              <Faq q="Why do I need to sign in or paste a cookie?">
                YouTube blocks the player API from datacenter IPs (the Worker) with a bot challenge. To load a track that
                isn't already cached, the Worker needs credentials YouTube trusts — your signed-in session.
              </Faq>
              <Faq q="Where are my credentials stored?">
                The <strong>Google account token</strong> stays only in this browser (revoke anytime at Google's
                “Third-party access”). The <strong>streaming cookie</strong> is kept only in memory for this browser
                session — never written to disk, trimmed to the minimum cookies, auto-expiring, gone when you close the
                tab. It's sent only to this site's own Worker, which forwards it to YouTube and never stores, logs, or
                shares it.
              </Faq>
              <Faq q="What does the account see?">
                While connected, YouTube sees those requests as your account, from the Worker's IP. Treat it like signing
                in elsewhere — use an account you're comfortable with, and disconnect to remove it. For zero exposure,
                export cookies while signed out (anonymous) or use a throwaway account.
              </Faq>
              <Faq q="Is the cached audio shared?">
                Yes — audio, stems, and analysis are cached by video id and shared across users so nothing is fetched or
                separated twice. <strong>Your credentials are never part of it.</strong>
              </Faq>

              <div className="info-links">
                <a href="https://handlingtheloop.com" target="_blank" rel="noreferrer noopener">
                  handlingtheloop.com
                </a>
                <a href="https://github.com/asuramaya/handlingtheloop" target="_blank" rel="noreferrer noopener">
                  GitHub
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="faq-item">
      <div className="faq-q">{q}</div>
      <p className="faq-a">{children}</p>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="settings-row slider-row">
      <span className="settings-label">
        {label} <span className="slider-hint">{hint}</span>
      </span>
      <input
        type="range"
        className="settings-slider"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

// One connected-service row: name, status dot, and a connect/disconnect action.
function ConnRow({
  label,
  connected,
  note,
  actionLabel,
  onAction,
}: {
  label: string;
  connected: boolean;
  note?: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="conn-row">
      <span className={`conn-dot ${connected ? "on" : ""}`} />
      <span className="conn-name">{label}</span>
      {connected && note && <span className="conn-note">{note}</span>}
      <button className="hw-btn small conn-action" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}
