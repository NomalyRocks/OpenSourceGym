import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "./auth";
import { errorMessage } from "../i18n/errors";

/**
 * Signing out is a network request: if it fails silently the member would not
 * realize the session is still active, so the error is surfaced and the action
 * stays retryable. The calculator's on-device health data is removed by the
 * session-loss effect in App.tsx, the only path that also covers revoked sessions.
 */
export function useSignOut() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Resolves true when the session ended. */
  async function signOut(): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      // better-auth reports a failed sign-out by returning `error` rather than
      // throwing, so the catch block alone would miss it.
      const { error: signOutError } = await authClient.signOut();
      if (signOutError) {
        setError(
          errorMessage(
            signOutError,
            t,
            "Could not sign out. Please try again.",
          ),
        );
        return false;
      }
      return true;
    } catch (caught) {
      setError(
        errorMessage(caught, t, "Could not sign out. Please try again."),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { signOut, busy, error, clearError: () => setError(null) };
}
