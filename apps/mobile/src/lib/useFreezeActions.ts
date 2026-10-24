import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MyFreezeAllowance } from "@opengym/shared";
import { api } from "./api";
import { errorMessage } from "../i18n/errors";

export type FreezeSheet = "freeze" | "resume" | null;

/**
 * Freeze / resume flow behind a confirmation sheet. `onChanged` runs after a
 * successful change and also after a failed one (the state may have changed
 * server-side, e.g. already frozen), so callers can reload. A failure keeps the
 * sheet open with `error`; success closes it.
 */
export function useFreezeActions({
  allowance,
  onChanged,
}: {
  allowance: MyFreezeAllowance | null;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [sheet, setSheet] = useState<FreezeSheet>(null);
  // Survives close so a fading-out sheet keeps its content instead of flipping.
  const [kind, setKind] = useState<Exclude<FreezeSheet, null>>("freeze");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref guards double taps: state updates land after the second press.
  const busyRef = useRef(false);

  function open(kind: Exclude<FreezeSheet, null>) {
    setError(null);
    setKind(kind);
    setSheet(kind);
  }

  function close() {
    if (busyRef.current) return;
    setSheet(null);
    setError(null);
  }

  async function confirm() {
    if (!sheet || busyRef.current) return;
    const method = sheet === "freeze" ? "POST" : "DELETE";
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/freeze", { method });
      setSheet(null);
      await onChanged();
    } catch (caught) {
      setError(
        errorMessage(
          caught,
          t,
          method === "POST"
            ? "The membership could not be frozen. Please try again."
            : "The membership could not be resumed. Please try again.",
        ),
      );
      // The state may have changed server-side; refresh underneath the sheet.
      void onChanged();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return {
    sheet,
    /** Last opened kind; render sheet content from this, not `sheet` */
    kind,
    busy,
    error,
    allowance,
    openFreeze: () => open("freeze"),
    openResume: () => open("resume"),
    confirm,
    close,
  };
}
