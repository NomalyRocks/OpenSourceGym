import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { MemberDetail, MfaMethod, PublicUser } from "@opengym/shared";
import { ApiError, api, authApi, isAbortError } from "../lib/api";
import { useProfile } from "../lib/profile";
import { errorMessage } from "../i18n/errors";
import { roleKey } from "../lib/roleKey";
import { Avatar } from "./Avatar";
import { MemberControls } from "./MemberControls";
import { Modal } from "./Modal";
import { StatusBadge } from "./StatusBadge";
import { SubscriptionPanel } from "./SubscriptionPanel";

interface MfaPrompt {
  target: PublicUser;
  role: string;
}

/**
 * Side drawer for one user: identity, role, status, member controls and the
 * subscription panel. Loads its own data, so any page can open it by user id.
 */
export function MemberDrawer({
  userId,
  onClose,
  onChanged,
}: {
  userId: string;
  onClose: () => void;
  /** Called after anything changed that a parent list may show. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const { profile: user } = useProfile();
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  // Bumped when a freeze changes period dates, so the subscription list reloads.
  const [reloadKey, setReloadKey] = useState(0);

  const [mfaPrompt, setMfaPrompt] = useState<MfaPrompt | null>(null);
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>("totp");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaInfo, setMfaInfo] = useState<string | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setDetail(
        await api<MemberDetail>(`/api/admin/users/${userId}`, { signal }),
      );
    },
    [userId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setLoadError(null);
    setMsg(null);
    load(controller.signal).catch((err) => {
      if (isAbortError(err)) return;
      setLoadError(errorMessage(err, t, "Could not load data."));
    });
    return () => controller.abort();
  }, [load, t]);

  // Reload without clearing the drawer, so open modals and panels survive.
  const refresh = useCallback(async () => {
    try {
      await load();
    } catch (err) {
      setLoadError(errorMessage(err, t, "Could not load data."));
    }
    onChanged?.();
  }, [load, onChanged, t]);

  async function applyRole(
    target: PublicUser,
    role: string,
    mfa?: { mfaCode: string; mfaMethod: MfaMethod },
  ) {
    await api(`/api/admin/users/${target.id}/role`, {
      method: "POST",
      body: { role, ...mfa },
    });
    setMsg({
      kind: "success",
      text: t("{{email}} was updated to {{role}}.", {
        email: target.email,
        role: t(roleKey(role as PublicUser["role"])),
      }),
    });
    await refresh();
  }

  async function setRole(target: PublicUser, role: string) {
    setMsg(null);
    try {
      await applyRole(target, role);
    } catch (err) {
      if (err instanceof ApiError && err.code === "MFA_REQUIRED") {
        setMfaPrompt({ target, role });
        setMfaMethod("totp");
        setMfaCode("");
        setMfaError(null);
        setMfaInfo(null);
        return;
      }
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Could not assign the role."),
      });
    }
  }

  async function chooseMfaMethod(method: MfaMethod) {
    setMfaMethod(method);
    setMfaCode("");
    setMfaError(null);
    setMfaInfo(null);
    if (method === "otp") {
      try {
        await authApi("/two-factor/send-otp", {});
        setMfaInfo(t("A code was sent to your email."));
      } catch (err) {
        setMfaError(errorMessage(err, t, "The code could not be sent."));
      }
    }
  }

  async function confirmMfa() {
    if (!mfaPrompt) return;
    setMfaBusy(true);
    setMfaError(null);
    try {
      await applyRole(mfaPrompt.target, mfaPrompt.role, {
        mfaCode,
        mfaMethod,
      });
      setMfaPrompt(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "MFA_INVALID") {
        setMfaError(t("The code is invalid."));
      } else {
        setMfaError(errorMessage(err, t, "Verification failed."));
      }
    } finally {
      setMfaBusy(false);
    }
  }

  const target = detail?.user ?? null;
  const fullName = target ? `${target.firstName} ${target.lastName}` : "";
  const role = user?.role;

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-label={fullName || t("Loading…")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          {target ? (
            <div className="member-identity">
              <Avatar member={target} large />
              <div>
                <div>{fullName}</div>
                <div className="hint">{target.email}</div>
              </div>
            </div>
          ) : (
            <div className="hint">{loadError ? "" : t("Loading…")}</div>
          )}
          <button
            type="button"
            className="ghost"
            aria-label={t("Close")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        {loadError && <div className="msg error">{loadError}</div>}
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        {detail && target && (
          <>
            <div className="panel">
              <div className="row role-row">
                <span className={`badge ${target.role}`}>
                  {t(roleKey(target.role))}
                </span>
                <StatusBadge status={target.subscriptionStatus} />
                {role === "owner" && target.id !== user?.id && (
                  <select
                    className="role-select"
                    aria-label={t("Role")}
                    value={target.role}
                    onChange={(e) => void setRole(target, e.target.value)}
                  >
                    <option value="member">{t("Member")}</option>
                    <option value="staff">{t("Staff")}</option>
                    <option value="admin">{t("Administrator")}</option>
                    <option value="owner">{t("Owner")}</option>
                  </select>
                )}
              </div>
            </div>
            {target.role === "member" && (
              <MemberControls
                detail={detail}
                canBan={role === "owner" || role === "admin"}
                notify={(kind, text) => setMsg({ kind, text })}
                onChanged={() => {
                  setReloadKey((k) => k + 1);
                  void refresh();
                }}
              />
            )}
            <SubscriptionPanel
              key={target.id}
              member={target}
              reloadKey={reloadKey}
              onGranted={() => void refresh()}
            />
          </>
        )}
      </aside>
      {mfaPrompt && (
        <Modal
          title={t("MFA verification required")}
          busy={mfaBusy}
          onClose={() => setMfaPrompt(null)}
        >
          <p className="hint" style={{ marginBottom: 16 }}>
            {t("Enter a verification code to change {{email}} to {{role}}.", {
              email: mfaPrompt.target.email,
              role: t(roleKey(mfaPrompt.role as PublicUser["role"])),
            })}
          </p>
          {mfaError && <div className="msg error">{mfaError}</div>}
          {mfaInfo && <div className="msg success">{mfaInfo}</div>}
          <div className="row" style={{ marginBottom: 16 }}>
            <button
              type="button"
              className={mfaMethod === "totp" ? "" : "ghost"}
              onClick={() => void chooseMfaMethod("totp")}
            >
              {t("Authenticator")}
            </button>
            <button
              type="button"
              className={mfaMethod === "otp" ? "" : "ghost"}
              onClick={() => void chooseMfaMethod("otp")}
            >
              {t("Email code")}
            </button>
          </div>
          <div className="field">
            <label htmlFor="mfaCode">{t("Verification code")}</label>
            <input
              id="mfaCode"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() => void confirmMfa()}
              disabled={mfaBusy || !mfaCode}
            >
              {mfaBusy ? t("Verifying…") : t("Approve")}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setMfaPrompt(null)}
              disabled={mfaBusy}
            >
              {t("Cancel")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
