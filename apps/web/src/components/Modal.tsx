import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import type { WebTranslationKey } from "../i18n/resources";

export function useDateFormatter() {
  const { i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  return (value: Date | string) =>
    new Date(value).toLocaleDateString(locale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
}

/**
 * Modal shell: Esc, overlay click and the close handler are ignored while a
 * request is in flight. Rendered in a portal because the drawer is transformed,
 * which would otherwise make `position: fixed` relative to the drawer.
 */
export function Modal({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="panel wide"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirm dialog around an async action. The action runs once (double clicks
 * are ignored), errors stay inside the dialog, and the parent closes it on
 * success by unmounting it.
 */
export function ConfirmModal({
  title,
  confirmLabel,
  errorFallback,
  danger,
  disabled,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  confirmLabel: string;
  errorFallback: WebTranslationKey;
  danger?: boolean;
  /** Extra condition that keeps the confirm button disabled (e.g. invalid input) */
  disabled?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  async function run() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err, t, errorFallback));
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title={title} busy={busy} onClose={onClose}>
      {error && <div className="msg error">{error}</div>}
      {children}
      <div className="row">
        <button
          type="button"
          className={danger ? "danger" : undefined}
          onClick={() => void run()}
          disabled={busy || disabled}
        >
          {busy ? t("Processing…") : confirmLabel}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onClose}
          disabled={busy}
        >
          {t("Cancel")}
        </button>
      </div>
    </Modal>
  );
}
