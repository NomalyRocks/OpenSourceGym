import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Mail, ShieldCheck } from "lucide-react";
import type {
  AcceptMemberInviteRequest,
  AcceptMemberInviteResponse,
  InviteLookupResponse,
} from "@opengym/shared";
import { api, ApiError, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import "./Invite.css";

export function Invite() {
  const { t } = useTranslation();
  const [token] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "",
  );
  const [invite, setInvite] = useState<InviteLookupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [processing, setProcessing] = useState(false);
  const [dataAccepted, setDataAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const busy = useRef(false);

  const lookup = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setInvite(null);
      setDataAccepted(false);
      setPrivacyAccepted(false);
      try {
        setInvite(
          await api<InviteLookupResponse>("/api/invites/lookup", {
            method: "POST",
            body: { token },
            signal,
          }),
        );
        setError("");
      } catch (err) {
        if (isAbortError(err)) return;
        if (err instanceof ApiError && err.code === "INVITE_INVALID")
          setInvalid(true);
        else setError(errorMessage(err, t, "Could not load the invitation."));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [token, t],
  );

  useEffect(() => {
    // Remove the bearer credential from the address bar before opening documents.
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    const controller = new AbortController();
    void lookup(controller.signal);
    return () => controller.abort();
  }, [lookup]);

  async function accept(event: React.FormEvent) {
    event.preventDefault();
    if (!invite || busy.current || !dataAccepted || !privacyAccepted) return;
    if (password !== confirm) {
      setError(t("Passwords do not match."));
      return;
    }
    busy.current = true;
    setProcessing(true);
    setError("");
    setNotice("");
    try {
      const body: AcceptMemberInviteRequest = {
        token,
        password,
        dataProcessingAccepted: true,
        privacyAccepted: true,
        legalVersion: invite.legal.version,
      };
      await api<AcceptMemberInviteResponse>("/api/invites/accept", {
        method: "POST",
        body,
      });
      setPassword("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "LEGAL_VERSION_CHANGED") {
        setDataAccepted(false);
        setPrivacyAccepted(false);
        setNotice(
          t(
            "The legal documents changed. Read them again and give both consents.",
          ),
        );
        await lookup();
      } else if (err instanceof ApiError && err.code === "INVITE_INVALID")
        setInvalid(true);
      else setError(errorMessage(err, t, "Could not accept the invitation."));
    } finally {
      busy.current = false;
      setProcessing(false);
    }
  }

  return (
    <main className="invite-wrap">
      <div className="invite-card">
        <div className="invite-brand">
          <span>OPENGYM</span>
          <LanguageSwitcher compact />
        </div>
        {done ? (
          <div role="status">
            <CheckCircle2 size={36} className="invite-symbol" />
            <h1>{t("Welcome aboard")}</h1>
            <p>
              {t("Your account is ready. Sign in with the OpenGym mobile app.")}
            </p>
          </div>
        ) : invalid ? (
          <div role="alert">
            <h1>{t("Invitation unavailable")}</h1>
            <p>
              {t(
                "This invitation link is invalid or has expired. Ask the gym for a new one.",
              )}
            </p>
          </div>
        ) : loading ? (
          <p role="status">{t("Loading…")}</p>
        ) : (
          <>
            {invite && (
              <>
                <ShieldCheck size={30} className="invite-symbol" />
                <p className="invite-chain">{invite.chainName}</p>
                <h1>{t("Hello, {{name}}", { name: invite.firstName })}</h1>
                <p>
                  {t(
                    "Read the documents below and set a password to create your account.",
                  )}
                </p>
                <div className="invite-email">
                  <Mail size={16} aria-hidden="true" />
                  {invite.email}
                </div>
              </>
            )}
            {notice && (
              <div className="msg" role="status">
                {notice}
              </div>
            )}
            {error && (
              <div className="msg error" role="alert">
                {error}
              </div>
            )}
            {!invite && (
              <button type="button" onClick={() => void lookup()}>
                {t("Try again")}
              </button>
            )}
            {invite && (
              <form onSubmit={(event) => void accept(event)}>
                <fieldset className="invite-consents" disabled={processing}>
                  <legend>{t("Your consent")}</legend>
                  <label>
                    <input
                      type="checkbox"
                      required
                      checked={dataAccepted}
                      onChange={(event) =>
                        setDataAccepted(event.target.checked)
                      }
                    />
                    <span>
                      {t("I have read and accept the data processing notice.")}
                      {invite.legal.dataProcessingUrl && (
                        <a
                          href={invite.legal.dataProcessingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("Read data processing notice")}
                        </a>
                      )}
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      required
                      checked={privacyAccepted}
                      onChange={(event) =>
                        setPrivacyAccepted(event.target.checked)
                      }
                    />
                    <span>
                      {t("I have read and accept the privacy policy.")}
                      {invite.legal.privacyUrl && (
                        <a
                          href={invite.legal.privacyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("Read privacy policy")}
                        </a>
                      )}
                    </span>
                  </label>
                </fieldset>
                <div className="field">
                  <label htmlFor="invite-password">{t("Password")}</label>
                  <input
                    id="invite-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    maxLength={128}
                    value={password}
                    disabled={processing}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <span className="hint">{t("Use 8 to 128 characters.")}</span>
                </div>
                <div className="field">
                  <label htmlFor="invite-confirm">
                    {t("Confirm password")}
                  </label>
                  <input
                    id="invite-confirm"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    maxLength={128}
                    value={confirm}
                    disabled={processing}
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                </div>
                <button
                  className="invite-submit"
                  disabled={processing || !dataAccepted || !privacyAccepted}
                >
                  {processing ? t("Processing…") : t("Create my account")}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </main>
  );
}
