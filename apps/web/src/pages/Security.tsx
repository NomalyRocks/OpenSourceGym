import { useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { authApi } from "../lib/api";
import { useProfile } from "../lib/profile";

interface MfaSetup {
  qr: string;
  backupCodes: string[];
}

export function Security() {
  const { t } = useTranslation();
  const { profile, refresh } = useProfile();
  const [password, setPassword] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const data = await authApi<{ totpURI: string; backupCodes: string[] }>(
        "/two-factor/enable",
        { password },
      );
      const qr = await QRCode.toDataURL(data.totpURI);
      setSetup({ qr, backupCodes: data.backupCodes });
      setPassword("");
      setCopied(false);
    } catch {
      setMsg({ kind: "error", text: t("The password is incorrect.") });
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await authApi("/two-factor/verify-totp", { code });
      setSetup(null);
      setCode("");
      setMsg({ kind: "success", text: t("MFA was enabled.") });
      await refresh();
    } catch {
      setMsg({
        kind: "error",
        text: t("The code is invalid or has expired."),
      });
    } finally {
      setBusy(false);
    }
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await authApi("/two-factor/disable", { password: disablePassword });
      setDisablePassword("");
      setMsg({ kind: "success", text: t("MFA was disabled.") });
      await refresh();
    } catch {
      setMsg({ kind: "error", text: t("The password is incorrect.") });
    } finally {
      setBusy(false);
    }
  }

  async function copyBackupCodes() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.backupCodes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="stagger">
      <h1>{t("Security")}</h1>
      <div className="panel" style={{ maxWidth: 560 }}>
        <h2>{t("Two-factor authentication (MFA)")}</h2>
        <p style={{ marginBottom: 16 }}>
          {profile?.twoFactorEnabled ? (
            <span className="badge ok">{t("MFA enabled")}</span>
          ) : (
            <span className="badge member">{t("MFA disabled")}</span>
          )}
        </p>
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

        {!profile?.twoFactorEnabled && !setup && (
          <form className="row" onSubmit={enable}>
            <div className="field">
              <label htmlFor="enablePassword">{t("Password")}</label>
              <input
                id="enablePassword"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button type="submit" disabled={busy}>
              {busy ? t("Processing…") : t("Enable MFA")}
            </button>
          </form>
        )}

        {setup && (
          <div>
            <div className="qr-box">
              <img src={setup.qr} alt={t("MFA QR code")} />
            </div>
            <p className="hint" style={{ marginBottom: 16 }}>
              {t(
                "Scan the QR code above with your authenticator app (Google Authenticator, Authy, etc.).",
              )}
            </p>
            <h3 style={{ marginBottom: 8 }}>{t("Backup codes")}</h3>
            <div className="code-block">{setup.backupCodes.join("\n")}</div>
            <div className="row" style={{ marginBottom: 14 }}>
              <button
                type="button"
                className="ghost"
                onClick={() => void copyBackupCodes()}
              >
                {copied ? t("Copied") : t("Copy")}
              </button>
            </div>
            <div className="msg warn">
              {t("Backup codes are shown only once; store them securely.")}
            </div>
            <form onSubmit={verify} className="row" style={{ marginTop: 6 }}>
              <div className="field">
                <label htmlFor="totpCode">{t("Verification code")}</label>
                <input
                  id="totpCode"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  required
                />
              </div>
              <button type="submit" disabled={busy}>
                {busy ? t("Verifying…") : t("Verify")}
              </button>
            </form>
          </div>
        )}

        {profile?.twoFactorEnabled && (
          <form className="row" onSubmit={disable}>
            <div className="field">
              <label htmlFor="disablePassword">{t("Password")}</label>
              <input
                id="disablePassword"
                type="password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button type="submit" className="ghost" disabled={busy}>
              {busy ? t("Processing…") : t("Disable MFA")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
