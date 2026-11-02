import type { CrashPrompt } from "../App/crashPrompt";

// The boot-time question a standing crash guard asks (see App/crashPrompt.ts for the rule).
//
// NOT A TOAST: a toast self-dismisses, and this has to wait for an answer. Also NOT A MODAL: the
// deck stays playable underneath (the plain mix always works), so the board is not taken hostage
// over an optional feature. Fixed at the top, out of the toast stack's way at the bottom.
export function CrashGuardPrompt({
  prompts,
  onAnswer,
}: {
  prompts: CrashPrompt[];
  onAnswer: (id: CrashPrompt["id"], tryAgain: boolean) => void;
}) {
  if (!prompts.length) return null;
  return (
    <div className="crash-prompts">
      {prompts.map((p) => (
        <div key={p.id} className="crash-prompt" role="alertdialog" aria-labelledby={`crash-${p.id}-t`} aria-describedby={`crash-${p.id}-b`}>
          <div className="crash-prompt-title" id={`crash-${p.id}-t`}>{p.title}</div>
          <div className="crash-prompt-body" id={`crash-${p.id}-b`}>{p.body}</div>
          <div className="crash-prompt-actions">
            <button type="button" className="crash-prompt-decline" onClick={() => onAnswer(p.id, false)}>
              {p.decline}
            </button>
            <button type="button" className="crash-prompt-accept" onClick={() => onAnswer(p.id, true)}>
              {p.accept}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
