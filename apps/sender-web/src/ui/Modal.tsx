import { type ReactNode, useEffect, useId, useRef } from "react";

/**
 * A dialog on the browser's own <dialog>: it traps focus, closes on Escape,
 * and puts the page behind it out of reach. Its children are only rendered
 * while it is open, so each opening starts from fresh state.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noNoninteractiveElementInteractions: Escape and the close button already work from the keyboard; a click on the backdrop is a mouse shortcut.
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself.
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="modal-body">
          <div className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** A button that shows work in progress and can't be pressed twice. */
export function LoadingButton({
  loading,
  label,
  loadingLabel,
  disabled,
  onClick,
  className = "btn",
}: {
  loading: boolean;
  label: string;
  loadingLabel: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`${className}${loading ? " loading" : ""}`}
      disabled={disabled || loading}
      aria-busy={loading}
      onClick={onClick}
    >
      {loading && <span className="spinner" aria-hidden="true" />}
      {loading ? loadingLabel : label}
    </button>
  );
}
