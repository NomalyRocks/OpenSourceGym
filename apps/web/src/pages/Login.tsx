import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authApi, ApiError } from "../lib/api";
import { useSessionUser } from "../lib/auth";
import { AuthLayout } from "../components/AuthLayout";
import { errorMessage } from "../i18n/errors";

type Step = "password" | "code" | "forgot" | "reset";
type Method = "totp" | "otp";

export function Login() {
  const { t } = useTranslation();
  const { refetch } = useSessionUser();
  const [step, setStep] = useState<Step>("password");
  const [method, setMethod] = useState<Method>("totp");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [resetOtp, setResetOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const data = await authApi<{ twoFactorRedirect?: boolean }>(
        "/sign-in/email",
        { email, password },
      );
      if (data.twoFactorRedirect) {
        setStep("code");
        setMethod("totp");
        setCode("");
        setInfo(null);
      } else {
        await refetch();
        // On success, useSession updates and the router redirects
      }
    } catch (err) {
      setError(errorMessage(err, t, "Sign-in failed."));
    } finally {
      setBusy(false);
    }
  }

  async function sendEmailCode() {
    setBusy(true);
    setError(null);
    try {
      await authApi("/two-factor/send-otp", {});
      setMethod("otp");
      setCode("");
      setInfo(t("A code was sent to your email."));
    } catch (err) {
      setError(errorMessage(err, t, "The code could not be sent."));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path =
        method === "totp"
          ? "/two-factor/verify-totp"
          : "/two-factor/verify-otp";
      await authApi(path, { code });
      await refetch();
      // On success, useSession updates and the router redirects
    } catch {
      setError(t("The code is invalid or has expired."));
    } finally {
      setBusy(false);
    }
  }

  function backToPassword() {
    setStep("password");
    setCode("");
    setError(null);
    setInfo(null);
    setMethod("totp");
  }

  function goToForgot() {
    setStep("forgot");
    setError(null);
    setInfo(null);
  }

  function backToPasswordFromForgot() {
    setStep("password");
    setError(null);
    setInfo(null);
  }

  function backToPasswordFromReset() {
    setStep("password");
    setResetOtp("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setInfo(null);
  }

  function forgotErrorMessage(err: unknown): string {
    if (err instanceof ApiError && err.status === 429) {
      return t("Too many attempts. Please wait one minute.");
    }
    return t("The request could not be sent. Please try again.");
  }

  async function requestResetCode() {
    await authApi("/email-otp/request-password-reset", { email });
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestResetCode();
      setInfo(t("A password reset code was sent to your email."));
      setStep("reset");
    } catch (err) {
      setError(forgotErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resendResetCode() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await requestResetCode();
      setResetOtp("");
      setInfo(t("A new code was sent to your email."));
    } catch (err) {
      setError(forgotErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (newPassword.length < 8) {
      setError(t("The password must be at least 8 characters."));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("Passwords do not match."));
      return;
    }
    setBusy(true);
    try {
      await authApi("/email-otp/reset-password", {
        email,
        otp: resetOtp,
        password: newPassword,
      });
      setStep("password");
      setPassword("");
      setResetOtp("");
      setNewPassword("");
      setConfirmPassword("");
      setError(null);
      setInfo(t("Your password was updated. Please sign in."));
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError(t("Too many attempts. Please wait one minute."));
        } else if (err.code === "INVALID_OTP") {
          setError(t("The code is invalid."));
        } else if (err.code === "OTP_EXPIRED") {
          setError(t("The code has expired."));
        } else if (err.code === "TOO_MANY_ATTEMPTS") {
          setError(t("Too many invalid attempts. Request a new code."));
        } else if (err.code === "PASSWORD_TOO_SHORT") {
          setError(t("The password is too short."));
        } else {
          setError(t("Password reset failed."));
        }
      } else {
        setError(t("Password reset failed."));
      }
    } finally {
      setBusy(false);
    }
  }

  if (step === "forgot") {
    return (
      <AuthLayout>
        <form onSubmit={submitForgot}>
          <h1>
            Open
            <em style={{ color: "var(--accent)", fontStyle: "normal" }}>Gym</em>
          </h1>
          <p className="sub">{t("Reset password")}</p>
          {error && <div className="msg error">{error}</div>}
          {info && <div className="msg success">{info}</div>}
          <div className="field">
            <label htmlFor="forgot-email">{t("Email")}</label>
            <input
              id="forgot-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <button type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? t("Sending…") : t("Send reset code")}
          </button>
          <div className="row" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="link-btn"
              onClick={backToPasswordFromForgot}
              disabled={busy}
            >
              {t("Back")}
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  if (step === "reset") {
    return (
      <AuthLayout>
        <form onSubmit={submitReset}>
          <h1>
            Open
            <em style={{ color: "var(--accent)", fontStyle: "normal" }}>Gym</em>
          </h1>
          <p className="sub">{t("Set a new password")}</p>
          {error && <div className="msg error">{error}</div>}
          {info && <div className="msg success">{info}</div>}
          <div className="field">
            <label htmlFor="reset-email">{t("Email")}</label>
            <input
              id="reset-email"
              type="email"
              value={email}
              readOnly
              autoComplete="username"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="reset-otp">{t("Verification code")}</label>
            <input
              id="reset-otp"
              value={resetOtp}
              onChange={(e) => setResetOtp(e.target.value)}
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              required
            />
          </div>
          <div className="field">
            <label htmlFor="new-password">{t("New password")}</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="confirm-password">
              {t("Confirm new password")}
            </label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? t("Updating…") : t("Update password")}
          </button>
          <div
            className="row"
            style={{ marginTop: 16, justifyContent: "space-between" }}
          >
            <button
              type="button"
              className="link-btn"
              onClick={backToPasswordFromReset}
              disabled={busy}
            >
              {t("Back")}
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => void resendResetCode()}
              disabled={busy}
            >
              {t("Resend code")}
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  if (step === "code") {
    return (
      <AuthLayout>
        <form onSubmit={submitCode}>
          <h1>
            Open
            <em style={{ color: "var(--accent)", fontStyle: "normal" }}>Gym</em>
          </h1>
          <p className="sub">{t("Two-factor authentication")}</p>
          {error && <div className="msg error">{error}</div>}
          {info && <div className="msg success">{info}</div>}
          <div className="field">
            <label htmlFor="code">{t("Verification code")}</label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </div>
          <button type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? t("Verifying…") : t("Verify")}
          </button>
          <div
            className="row"
            style={{ marginTop: 16, justifyContent: "space-between" }}
          >
            <button
              type="button"
              className="link-btn"
              onClick={backToPassword}
              disabled={busy}
            >
              {t("Back")}
            </button>
            {method === "totp" && (
              <button
                type="button"
                className="link-btn"
                onClick={() => void sendEmailCode()}
                disabled={busy}
              >
                {t("Send code by email")}
              </button>
            )}
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form onSubmit={submitPassword}>
        <h1>
          Open
          <em style={{ color: "var(--accent)", fontStyle: "normal" }}>Gym</em>
        </h1>
        <p className="sub">{t("Admin panel — staff sign-in")}</p>
        {error && <div className="msg error">{error}</div>}
        {info && <div className="msg success">{info}</div>}
        <div className="field">
          <label htmlFor="email">{t("Email")}</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t("Password")}</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? t("Signing in…") : t("Sign in")}
        </button>
        <div
          className="row"
          style={{ marginTop: 16, justifyContent: "flex-end" }}
        >
          <button
            type="button"
            className="link-btn"
            onClick={goToForgot}
            disabled={busy}
          >
            {t("Forgot password?")}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
