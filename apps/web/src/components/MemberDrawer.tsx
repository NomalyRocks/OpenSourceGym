import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type {
  Gym,
  MemberDetail,
  MfaMethod,
  PublicUser,
  SetUserGymsRequest,
} from "@opengym/shared";
import { ApiError, api, authApi, isAbortError } from "../lib/api";
import { useProfile } from "../lib/profile";
import { useGyms } from "../lib/gyms";
import { errorMessage } from "../i18n/errors";
import { roleKey } from "../lib/roleKey";
import { usePresenceFormat } from "../lib/presence";
import { Avatar } from "./Avatar";
import { MemberControls } from "./MemberControls";
import { ConfirmModal, Modal } from "./Modal";
import { StatusBadge } from "./StatusBadge";
import { SubscriptionPanel } from "./SubscriptionPanel";

interface MfaPrompt {
  target: PublicUser;
  role: string;
  /** Gyms to save after the role change; null when the role needs none. */
  gymIds: string[] | null;
}

/** Roles that only see the gyms listed on the account. */
function needsGyms(role: string): boolean {
  return role === "admin" || role === "staff";
}

/** Multi-select of gyms; inactive gyms only show when already selected. */
function GymChecklist({
  gyms,
  value,
  onChange,
}: {
  gyms: Gym[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="field">
      {gyms
        .filter((g) => g.active || value.includes(g.id))
        .map((g) => (
          <label key={g.id} className="check">
            <input
              type="checkbox"
              checked={value.includes(g.id)}
              onChange={() =>
                onChange(
                  value.includes(g.id)
                    ? value.filter((id) => id !== g.id)
                    : [...value, g.id],
                )
              }
            />{" "}
            {g.name}
            {!g.active && ` (${t("Inactive")})`}
          </label>
        ))}
    </div>
  );
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
  const { duration, time } = usePresenceFormat();
  const { gyms, refresh: refreshGyms } = useGyms();
  // Gym choice shown before an admin/staff role is applied.
  const [gymPick, setGymPick] = useState<{
    target: PublicUser;
    role: string;
    gymIds: string[];
  } | null>(null);
  // Role changed but the gym assignment failed; offered again for a retry.
  const [gymRetry, setGymRetry] = useState<{
    target: PublicUser;
    gymIds: string[];
  } | null>(null);
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

  async function saveGyms(targetId: string, gymIds: string[]) {
    const body: SetUserGymsRequest = { gymIds };
    await api(`/api/admin/users/${targetId}/gyms`, { method: "PUT", body });
    await refresh();
    void refreshGyms();
  }

  /**
   * Sets the role, then the gym scope. A role failure throws; a gym failure
   * after the role changed opens the retry modal instead, so it is never silent.
   */
  async function finishRole(
    target: PublicUser,
    role: string,
    gymIds: string[] | null,
    mfa?: { mfaCode: string; mfaMethod: MfaMethod },
  ) {
    await applyRole(target, role, mfa);
    if (!gymIds) return;
    try {
      await saveGyms(target.id, gymIds);
    } catch {
      setGymRetry({ target, gymIds });
    }
  }

  function openMfa(prompt: MfaPrompt) {
    setMfaPrompt(prompt);
    setMfaMethod("totp");
    setMfaCode("");
    setMfaError(null);
    setMfaInfo(null);
  }

  /** Entry point of the role select: admin/staff first ask for gyms. */
  async function setRole(target: PublicUser, role: string) {
    setMsg(null);
    if (needsGyms(role)) {
      const active = new Set(gyms.filter((g) => g.active).map((g) => g.id));
      setGymPick({
        target,
        role,
        gymIds: needsGyms(target.role)
          ? target.gymIds.filter((id) => active.has(id))
          : [],
      });
      return;
    }
    try {
      await finishRole(target, role, null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "MFA_REQUIRED") {
        openMfa({ target, role, gymIds: null });
        return;
      }
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Could not assign the role."),
      });
    }
  }

  async function confirmGymPick() {
    if (!gymPick) return;
    const { target, role, gymIds } = gymPick;
    try {
      await finishRole(target, role, gymIds);
      setGymPick(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "MFA_REQUIRED") {
        setGymPick(null);
        openMfa({ target, role, gymIds });
        return;
      }
      throw err;
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
      await finishRole(mfaPrompt.target, mfaPrompt.role, mfaPrompt.gymIds, {
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
              {target.role === "member" && (
                <div className="row" style={{ marginTop: 10 }}>
                  {target.presence ? (
                    <span className="presence">
                      <span className="presence-dot" aria-hidden="true" />
                      {t("Inside at {{gym}} since {{time}} ({{duration}})", {
                        gym: target.presence.gymName,
                        time: time(target.presence.enteredAt),
                        duration: duration(target.presence.enteredAt),
                      })}
                    </span>
                  ) : (
                    <span className="hint">{t("Not in a gym")}</span>
                  )}
                </div>
              )}
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
      {gymPick && (
        <ConfirmModal
          title={t("Assign gyms")}
          confirmLabel={t("Update role")}
          errorFallback="Could not assign the role."
          disabled={gymPick.gymIds.length === 0}
          onClose={() => setGymPick(null)}
          onConfirm={confirmGymPick}
        >
          <p className="hint" style={{ marginBottom: 12 }}>
            {t(
              "{{email}} will become {{role}}. Choose the gyms this account can work in (at least one).",
              {
                email: gymPick.target.email,
                role: t(roleKey(gymPick.role as PublicUser["role"])),
              },
            )}
          </p>
          <GymChecklist
            gyms={gyms}
            value={gymPick.gymIds}
            onChange={(gymIds) => setGymPick({ ...gymPick, gymIds })}
          />
        </ConfirmModal>
      )}
      {gymRetry && (
        <ConfirmModal
          title={t("Gyms were not saved")}
          confirmLabel={t("Retry")}
          errorFallback="Could not save changes."
          disabled={gymRetry.gymIds.length === 0}
          onClose={() => setGymRetry(null)}
          onConfirm={async () => {
            await saveGyms(gymRetry.target.id, gymRetry.gymIds);
            setGymRetry(null);
          }}
        >
          <div className="msg warn">
            {t(
              "The role was changed, but the gyms could not be saved. Until gyms are assigned this account sees no gym. Try again, or assign them later from Staff assignment.",
            )}
          </div>
          <GymChecklist
            gyms={gyms}
            value={gymRetry.gymIds}
            onChange={(gymIds) => setGymRetry({ ...gymRetry, gymIds })}
          />
        </ConfirmModal>
      )}
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
