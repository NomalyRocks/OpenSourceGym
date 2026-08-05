import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { AuthLayout } from "../components/AuthLayout";
import { errorMessage } from "../i18n/errors";

export function ChangePassword({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setError(t("The new passwords do not match."));
      return;
    }
    if (next.length < 8) {
      setError(t("The new password must be at least 8 characters."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/initial-password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err, t, "The operation failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <form onSubmit={submit}>
        <h1>{t("Change password")}</h1>
        <p className="sub">
          {t(
            "For security, you must change the default password before continuing.",
          )}
        </p>
        {error && <div className="msg error">{error}</div>}
        <div className="field">
          <label htmlFor="current">{t("Current password")}</label>
          <input
            id="current"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="next">{t("New password")}</label>
          <input
            id="next"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="confirm">{t("Confirm new password")}</label>
          <input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? t("Saving…") : t("Change password")}
        </button>
      </form>
    </AuthLayout>
  );
}
