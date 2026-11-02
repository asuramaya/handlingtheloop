// Settings ▸ Audio — where sound goes in and out: output and cue devices, the microphone, the
// master bus, and the FX preset banks. Stems and Lyrics are their own sections now (operator,
// 2026-11-02: "keep audio cleaner"); the stretch engine lives in Turntable ▸ Tempo.
import { useEffect, useState } from "react";
import { FxBankSettings } from "./FxBankSettings";
import { InfoDot } from "./InfoDot";
import { type Settings, isMobileDevice, MIC_NONE } from "@htl";
import { Slider } from "./Slider";

export function AudioTab({
  settings,
  set,
  outputSupported,
}: {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
  outputSupported: boolean;
}) {
  // Audio OUTPUT devices (speaker select). enumerateDevices only fills in `label`
  // once the page has been granted mic permission at least once; until then the OS
  // hides device names. `outputNeedsPerm` tracks that so we can offer a one-tap
  // "Show device names" that asks for (and immediately drops) a mic stream. Listed
  // only when the browser supports setSinkId.
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [outputNeedsPerm, setOutputNeedsPerm] = useState(false);
  const [outputPermErr, setOutputPermErr] = useState(""); // why a reveal failed (blocked / no device)
  useEffect(() => {
    if (!outputSupported || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
        if (cancelled) return;
        setOutputs(devs);
        // labels blank = permission not yet granted (names hidden by the OS)
        setOutputNeedsPerm(devs.length > 0 && devs.every((d) => !d.label));
      } catch {
        /* enumerate can throw in locked-down contexts; just show none */
      }
    };
    void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [outputSupported]);

  // Microphone INPUT devices (for the mic talkover + sampling source). Same label-permission
  // quirk as outputs; gated on getUserMedia. The "Show device names" reveal fills both.
  const micSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!micSupported || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
        if (!cancelled) setInputs(devs);
      } catch {
        /* ignore */
      }
    };
    void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [micSupported]);

  // One-shot: ask for mic permission so enumerateDevices reveals output labels,
  // then immediately stop the stream (we never record — we only want the names).
  const revealOutputNames = async () => {
    setOutputPermErr("");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      const all = await navigator.mediaDevices.enumerateDevices();
      const devs = all.filter((d) => d.kind === "audiooutput");
      setOutputs(devs);
      setInputs(all.filter((d) => d.kind === "audioinput")); // the same grant reveals mic names
      setOutputNeedsPerm(devs.length > 0 && devs.every((d) => !d.label));
    } catch (e) {
      // Surface WHY instead of silently no-op'ing (the old behaviour looked like the
      // button did nothing). NotAllowedError = blocked by the user OR by a restrictive
      // Permissions-Policy (microphone=()); NotFoundError = no input device.
      const name = e instanceof DOMException ? e.name : "";
      setOutputPermErr(
        name === "NotAllowedError"
          ? "Microphone access is blocked — allow it for this site (it's only used to read device names; nothing is recorded). On the deployed site this needs the latest build."
          : name === "NotFoundError"
            ? "No audio input device found — your OS hides output names until some audio device is available."
            : "Couldn't read device names on this browser.",
      );
    }
  };

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Output device (PA)</span>
          <InfoDot
            text="Your PA or house output: the speakers the room hears. It carries the main mix and the microphone. Headphones are chosen separately under Cue, so you can pre-listen to one deck while the room hears another."
            label="Output device"
          />
        </div>
        {outputSupported ? (
          <>
            <select
              className="settings-select"
              value={settings.audioOutputId}
              onChange={(e) => set({ audioOutputId: e.target.value })}
              aria-label="Output device"
            >
              <option value="">System default</option>
              {outputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Output ${i + 1}`}
                </option>
              ))}
            </select>
            {outputNeedsPerm && (
              <p className="settings-note">
                Device names stay hidden until you grant audio permission once.{" "}
                <button className="link-btn" onClick={revealOutputNames}>
                  Show device names
                </button>
              </p>
            )}
            {outputPermErr && <p className="settings-note warn">{outputPermErr}</p>}
          </>
        ) : (
          <p className="settings-note warn">
            This browser cannot switch outputs. Pick a speaker in your system sound settings, or use Chrome or Edge.
          </p>
        )}
      </div>

      {isMobileDevice() && (
        <div className="settings-section">
          <div className="settings-row">
            <span className="settings-label">
              Force wireless buffering
              <InfoDot
                text="Bluetooth and car-stereo skips are already handled on their own: dropouts are detected, buffering goes up, and it backs off once playback is clean. This pins the full buffer, about 120 milliseconds, from the start instead of waiting for the first skip. It costs a little latency on a wired output."
                label="Force wireless buffering"
              />
            </span>
            <button
              className={`toggle ${settings.wirelessOutput ? "on" : ""}`}
              onClick={() => set({ wirelessOutput: !settings.wirelessOutput })}
              role="switch"
              aria-checked={settings.wirelessOutput}
              aria-label="Force wireless buffering"
            >
              <span className="toggle-knob" />
            </button>
          </div>
        </div>
      )}

      {outputSupported && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">Cue / Headphone</span>
            <InfoDot
              text="Headphones for pre-listening a deck before the room hears it, like a DJ board. The deck's CUE button becomes a fader: tap to set or jump to the cue point, drag or scroll to set its headphone level. It taps before the channel fader, so a deck faded all the way out can still be cued."
              label="Cue / Headphone"
            />
          </div>
          <select
            className="settings-select"
            value={settings.audioCueOutputId}
            onChange={(e) => set({ audioCueOutputId: e.target.value })}
            aria-label="Cue output device"
          >
            <option value="">None — single output</option>
            {/* Exclude the main PA device — cueing to the SAME physical output double-plays the
                master to it (the cue's master-tap + the main path), phasing/doubling the mix. */}
            {outputs
              .filter((d) => !settings.audioOutputId || d.deviceId !== settings.audioOutputId)
              .map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Output ${i + 1}`}
                </option>
              ))}
          </select>
          {/* Bluetooth/wireless cue device → warn: A2DP adds large latency and can shift pitch
              (the cue routes through a MediaStream <audio> sink, unlike the native master). The
              fix is a wired/USB output — no code makes a Bluetooth cue accurate. (#13) */}
          {(() => {
            const cueLabel = outputs.find((d) => d.deviceId === settings.audioCueOutputId)?.label ?? "";
            return /\b(bluetooth|airpods?|wireless|bt|beats|buds|jabra)\b/i.test(cueLabel) ? (
              <p className="settings-note warn">
                <strong>{cueLabel}</strong> looks like a Bluetooth output. Wireless adds 150 to 300 milliseconds of
                latency and can shift the cue's pitch. Use a wired or USB output to cue accurately.
              </p>
            ) : null;
          })()}
          {outputNeedsPerm && (
            <p className="settings-note">
              Device names stay hidden until you grant audio permission once.{" "}
              <button className="link-btn" onClick={revealOutputNames}>
                Show device names
              </button>
            </p>
          )}
        </div>
      )}

      {micSupported && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">Microphone</span>
            <InfoDot
              text="A microphone for talkover and sampling. None is a real choice and the default: with None picked, the MIC, DUCK and MON controls are absent from the board entirely rather than sitting there unused. Switching device while the mic is live re-acquires it."
              label="Microphone"
            />
          </div>
          {/* ★ SAME SHAPE AS THE CUE OUTPUT ABOVE: "None" is a real, default choice, and choosing a
              device is what turns the feature on. The mic section of the board follows this select —
              pick None and MIC / DUCK / MON are gone from the board entirely, rather than sitting
              there forever for the (many) people who never use a microphone. */}
          <select className="settings-select" value={settings.audioInputId} onChange={(e) => set({ audioInputId: e.target.value })} aria-label="Microphone device">
            <option value={MIC_NONE}>None — no microphone</option>
            <option value="">System default mic</option>
            {inputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
          {/* A REPORT on the current state, not an explanation of the control — the explanation
              is behind the head's ⓘ. That is the whole split: `.settings-note` states a fact
              about right now, InfoDot answers "what is this". */}
          {settings.audioInputId === MIC_NONE && (
            <p className="settings-note">No microphone selected, so talkover, ducking and monitoring are off the board.</p>
          )}
          {inputs.length > 0 && inputs.every((d) => !d.label) && (
            <p className="settings-note">
              Device names stay hidden until you grant audio access once.{" "}
              <button className="link-btn" onClick={revealOutputNames}>
                Show device names
              </button>
            </p>
          )}
        </div>
      )}

      {/* The stretch engine and sync pull moved to Settings ▸ Turntable ▸ Tempo (how a deck moves
          and how its tempo sounds, in one place). What stayed is the master bus. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Master</span>
          <InfoDot
            text="The summed output of both decks: how much room it leaves before the limiter, and whether each deck is limited on its own first."
            label="Master"
          />
        </div>
        {/* ★ MASTER HEADROOM — the gain-staging answer to "the compressor punches from the other
            deck". Measured on the live FX harness (fxlab --master-duck): two decks summing past the
            master limiter's ceiling let a kick on one deck pull the OTHER down 1.88 dB for 130 ms,
            and no per-deck control can reach it, because the limiter sees the decks already summed.
            3 dB of trim here took it to 0.02 dB. It defaults to 0 — the fix costs output level, so
            it is offered, not imposed. */}
        <div className="settings-row">
          <span className="settings-label">
            Limit each deck
            <InfoDot label="Limit each deck" text="The master limiter hears BOTH decks at once, so one deck's kick asks it for gain reduction that lands on the other — that is the 'one deck pumps the other' effect, measured at 1.88 dB on a hot mix and 0.00 dB at a moderate one. Master headroom only moves the level where that starts; limiting each deck BEFORE they are summed can remove that shared stage, but measured it only works when each deck is held about 7 dB down: a limiter caps a signal rather than lowering it, so two decks sitting at the master's own ceiling still sum over it and the master reduces HARDER than before. This is therefore not a free alternative to headroom, it IS headroom taken per deck. Expect it quieter, and expect it to sound different, because two independent limiters do not sound like one bus limiter. Off by default — try it on a mix that pumps and keep it only if you prefer how it sounds." />
          </span>
          <button
            className={`toggle ${settings.perDeckLimiter ? "on" : ""}`}
            onClick={() => set({ perDeckLimiter: !settings.perDeckLimiter })}
            role="switch"
            aria-checked={settings.perDeckLimiter}
            aria-label="Limit each deck"
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <Slider
          label="Master headroom"
          info="How far the master is pulled down before the limiter. At 0 a loud two-deck mix runs into the ceiling, and the limiter — which hears both decks at once — ducks the whole mix on every kick, so one deck appears to pump the other. Measured: 3 dB of headroom removes that almost entirely. The cost is output level; every dB here is a dB quieter, so turn the amp up instead."
          hint={settings.masterHeadroomDb === 0 ? "none — loudest, may pump" : `${-settings.masterHeadroomDb} dB quieter`}
          value={settings.masterHeadroomDb}
          onChange={(v) => set({ masterHeadroomDb: v })}
          min={-12}
          max={0}
          step={1}
        />
      </div>

      <FxBankSettings />

    </>
  );
}
