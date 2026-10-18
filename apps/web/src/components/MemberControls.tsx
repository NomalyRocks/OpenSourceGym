import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  BanMemberRequest,
  CreateMemberDeletionRequest,
  MemberDetail,
} from "@opengym/shared";
import { api } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import type { WebTranslationKey } from "../i18n/resources";
import { ConfirmModal, useDateFormatter } from "./Modal";

type ControlModal = "ban" | "unban" | "freeze" | "deletion";

const BAN_REASON_MIN = 3;
const BAN_REASON_MAX = 500;
const DELETION_REASON_MAX = 500;

/**
 * Ban, freeze and deletion-on-behalf controls for a member. The role gating
 * here is UX only; the server checks the role on every endpoint.
 */
export function MemberControls({
  detail,
  canBan,
  onChanged,
  notify,
}: {
  detail: MemberDetail;
  /** Owner/admin only; staff cannot ban. */
  canBan: boolean;
  /** Reload the detail and the subscription list after a change. */
  onChanged: () => void;
  notify: (kind: "success" | "error", text: string) => void;
}) {
  const { t } = useTranslation();
  const formatDate = useDateFormatter();
  const [modal, setModal] = useState<ControlModal | null>(null);
  const [reason, setReason] = useState("");
  const [resuming, setResuming] = useState(false);
  const resumingRef = useRef(false);
  const userId = detail.user.id;
  const { ban, freeze, pendingDeletion } = detail;
  const cfg = freeze.config;

  function open(next: ControlModal) {
    setReason("");
    setModal(next);
  }

  async function run(action: () => Promise<unknown>, successText: string) {
    await action();
    setModal(null);
    notify("success", successText);
    onChanged();
  }

  async function resume() {
    if (resumingRef.current) return;
    resumingRef.current = true;
    setResuming(true);
    try {
      await api(`/api/admin/users/${userId}/freeze`, { method: "DELETE" });
      notify("success", t("Subscription resumed."));
      onChanged();
    } catch (err) {
      notify(
        "error",
        errorMessage(err, t, "Could not resume the subscription."),
      );
    } finally {
      resumingRef.current = false;
      setResuming(false);
    }
  }

  const freezeBlocked: WebTranslationKey | null = !cfg.enabled
    ? "Freezing is turned off in the chain settings."
    : freeze.usedInLastYear >= cfg.maxPerYear
      ? "The yearly freeze limit has been reached."
      : detail.user.subscriptionStatus !== "active"
        ? "The member has no active subscription period."
        : null;

  const trimmedReason = reason.trim();
  const banReasonValid =
    trimmedReason.length >= BAN_REASON_MIN &&
    trimmedReason.length <= BAN_REASON_MAX;

  return (
    <div className="panel">
      <h2>{t("Member controls")}</h2>

      {canBan && (
        <div className="control-row">
          <div className="control-info">
            <strong>{t("Ban")}</strong>
            {ban ? (
              <div className="msg error" style={{ marginTop: 8 }}>
                <strong>{t("This member is banned.")}</strong>
                <div>{ban.reason}</div>
                <div className="hint">
                  {t("Banned on {{date}} by {{name}}", {
                    date: formatDate(ban.bannedAt),
                    name: ban.bannedBy,
                  })}
                </div>
              </div>
            ) : (
              <span className="hint">
                {t("A banned member cannot enter any gym.")}
              </span>
            )}
          </div>
          {ban ? (
            <button
              type="button"
              className="ghost"
              onClick={() => open("unban")}
            >
              {t("Unban")}
            </button>
          ) : (
            <button
              type="button"
              className="danger"
              onClick={() => open("ban")}
            >
              {t("Ban member")}
            </button>
          )}
        </div>
      )}

      <div className="control-row">
        <div className="control-info">
          <strong>{t("Subscription freeze")}</strong>
          {freeze.active ? (
            <span className="hint">
              {t("Frozen since {{date}}", {
                date: formatDate(freeze.active.startedAt),
              })}
            </span>
          ) : (
            <span className="hint">
              {freezeBlocked
                ? t(freezeBlocked)
                : t("{{used}} of {{max}} freezes used in the last 365 days.", {
                    used: freeze.usedInLastYear,
                    max: cfg.maxPerYear,
                  })}
            </span>
          )}
        </div>
        {freeze.active ? (
          <button
            type="button"
            className="ghost"
            disabled={resuming}
            onClick={() => void resume()}
          >
            {resuming ? t("Processing…") : t("Resume")}
          </button>
        ) : (
          <button
            type="button"
            className="ghost"
            disabled={freezeBlocked !== null}
            title={freezeBlocked ? t(freezeBlocked) : undefined}
            onClick={() => open("freeze")}
          >
            {t("Freeze subscription")}
          </button>
        )}
      </div>

      <div className="control-row">
        <div className="control-info">
          <strong>{t("Account deletion")}</strong>
          {pendingDeletion ? (
            <span className="hint">
              {pendingDeletion.requestedBy
                ? t("Deletion requested on {{date}} by {{name}}", {
                    date: formatDate(pendingDeletion.requestedAt),
                    name: pendingDeletion.requestedBy.name,
                  })
                : t("Deletion requested on {{date}} by the member", {
                    date: formatDate(pendingDeletion.requestedAt),
                  })}
            </span>
          ) : (
            <span className="hint">
              {t("Open a deletion request on the member's behalf.")}
            </span>
          )}
        </div>
        {!pendingDeletion && (
          <button
            type="button"
            className="ghost"
            onClick={() => open("deletion")}
          >
            {t("Request deletion")}
          </button>
        )}
      </div>

      {modal === "ban" && (
        <ConfirmModal
          title={t("Ban member")}
          confirmLabel={t("Ban member")}
          errorFallback="Could not ban the member."
          danger
          disabled={!banReasonValid}
          onClose={() => setModal(null)}
          onConfirm={() =>
            run(() => {
              const body: BanMemberRequest = { reason: trimmedReason };
              return api(`/api/admin/users/${userId}/ban`, {
                method: "POST",
                body,
              });
            }, t("Member banned."))
          }
        >
          <p className="hint" style={{ marginBottom: 12 }}>
            {t(
              "The member will be refused at every gym and will see this reason in the mobile app.",
            )}
          </p>
          <div className="field">
            <label htmlFor="ban-reason">{t("Ban reason")}</label>
            <textarea
              id="ban-reason"
              rows={4}
              maxLength={BAN_REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
            <span className="hint">
              {t("{{min}}–{{max}} characters", {
                min: BAN_REASON_MIN,
                max: BAN_REASON_MAX,
              })}
            </span>
          </div>
        </ConfirmModal>
      )}

      {modal === "unban" && (
        <ConfirmModal
          title={t("Unban")}
          confirmLabel={t("Unban")}
          errorFallback="Could not unban the member."
          onClose={() => setModal(null)}
          onConfirm={() =>
            run(
              () => api(`/api/admin/users/${userId}/ban`, { method: "DELETE" }),
              t("Member unbanned."),
            )
          }
        >
          <p className="hint" style={{ marginBottom: 12 }}>
            {t("The member will be able to enter the gyms again.")}
          </p>
        </ConfirmModal>
      )}

      {modal === "freeze" && (
        <ConfirmModal
          title={t("Freeze subscription")}
          confirmLabel={t("Freeze subscription")}
          errorFallback="Could not freeze the subscription."
          onClose={() => setModal(null)}
          onConfirm={() =>
            run(
              () =>
                api(`/api/admin/users/${userId}/freeze`, { method: "POST" }),
              t("Subscription frozen."),
            )
          }
        >
          <ul className="modal-list" style={{ marginBottom: 14 }}>
            <li>
              {t("{{used}} of {{max}} freezes used in the last 365 days.", {
                used: freeze.usedInLastYear,
                max: cfg.maxPerYear,
              })}
            </li>
            <li>
              {t("At most {{days}} days are credited back to the member.", {
                days: cfg.maxDays,
              })}
            </li>
            <li>
              {t(
                "The member's next entry scan resumes the freeze automatically.",
              )}
            </li>
          </ul>
        </ConfirmModal>
      )}

      {modal === "deletion" && (
        <ConfirmModal
          title={t("Request deletion")}
          confirmLabel={t("Request deletion")}
          errorFallback="Could not request the deletion."
          danger
          onClose={() => setModal(null)}
          onConfirm={() =>
            run(() => {
              const body: CreateMemberDeletionRequest = trimmedReason
                ? { reason: trimmedReason }
                : {};
              return api(`/api/admin/users/${userId}/deletion-request`, {
                method: "POST",
                body,
              });
            }, t("Deletion request opened."))
          }
        >
          <div className="msg warn">
            {t(
              "This opens a data deletion request for the member. Nothing is deleted until the owner approves it.",
            )}
          </div>
          <div className="field">
            <label htmlFor="deletion-reason">{t("Reason (optional)")}</label>
            <textarea
              id="deletion-reason"
              rows={3}
              maxLength={DELETION_REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </ConfirmModal>
      )}
    </div>
  );
}
