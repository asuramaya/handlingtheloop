import type { ReactNode } from "react";
import { InfoDot } from "./InfoDot";

// ONE OPTION in a picker (stem engine, lyrics source): a compact single line — name, at most one
// small badge, and the explanation behind an ⓘ (operator, 2026-11-08: "clean up all the blobs of
// text into little i buttons"). It used to be a tall card with a sentence under every name, which
// is what made the Stems and Lyrics tabs read as walls of grey.
//
// A <div role="radio">, not a <button>: the ⓘ is itself a button, and a button inside a button is
// invalid HTML that browsers re-parent unpredictably. The ⓘ swallows its own click so opening it
// never also picks the option.
export function OptionRow({
  on,
  disabled,
  onPick,
  label,
  badge,
  info,
}: {
  on: boolean;
  disabled?: boolean;
  onPick: () => void;
  label: string;
  badge?: ReactNode;
  info?: string;
}) {
  return (
    <div
      role="radio"
      aria-checked={on}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={`stem-model ${on ? "on" : ""} ${disabled ? "blocked" : ""}`}
      onClick={() => !disabled && onPick()}
      onKeyDown={(e) => {
        if (disabled || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onPick();
      }}
    >
      <span className="stem-model-dot" aria-hidden="true" />
      <span className="stem-model-label">{label}</span>
      {badge}
      {info && (
        <span className="stem-model-info" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <InfoDot text={info} label={label} />
        </span>
      )}
    </div>
  );
}
