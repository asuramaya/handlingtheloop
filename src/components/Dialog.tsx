import { useEffect, useRef, useState } from "react";

// Styled replacements for window.prompt / window.confirm so dialogs match the
// app instead of the browser chrome.

export function PromptModal({
  title,
  initial = "",
  placeholder,
  submitLabel = "OK",
  onSubmit,
  onClose,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    onClose();
  };
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">{title}</h3>
        <input
          ref={ref}
          className="yt-input dialog-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="dialog-actions">
          <button className="hw-btn small" onClick={onClose}>
            Cancel
          </button>
          <button className="hw-btn small dialog-ok" onClick={submit} disabled={!value.trim()}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter") {
        onConfirm();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onConfirm]);
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="dialog" onPointerDown={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">{title}</h3>
        {message && <p className="dialog-msg">{message}</p>}
        <div className="dialog-actions">
          <button className="hw-btn small" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`hw-btn small ${danger ? "dialog-danger" : "dialog-ok"}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
