import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CreateMemberInviteRequest,
  MemberInvite,
  MemberInviteListResponse,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { useGymApi, useGymId, useGyms } from "../lib/gyms";
import { errorMessage } from "../i18n/errors";
import { ConfirmModal, Modal, useDateFormatter } from "./Modal";

export function InviteMemberModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const gymApi = useGymApi();
  const gymId = useGymId();
  const { gyms } = useGyms();
  const [form, setForm] = useState<CreateMemberInviteRequest>({
    email: "",
    firstName: "",
    lastName: "",
    phone: "",
  });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api<MemberInvite>(gymApi("/invites"), {
        method: "POST",
        body: form,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err, t, "Could not send the invitation."));
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title={t("Invite member")} busy={busy} onClose={onClose}>
      <p className="hint">
        {t("Gym")}: {gyms.find((gym) => gym.id === gymId)?.name}
      </p>
      <p className="hint" style={{ margin: "12px 0 20px" }}>
        {t(
          "The member gives consent and sets a password using the email link. The invitation expires in 7 days.",
        )}
      </p>
      {error && (
        <div className="msg error" role="alert">
          {error}
        </div>
      )}
      <form onSubmit={(event) => void submit(event)}>
        {(
          [
            ["email", "Email", "email", "email"],
            ["firstName", "First name", "text", "given-name"],
            ["lastName", "Last name", "text", "family-name"],
            ["phone", "Phone", "tel", "tel"],
          ] as const
        ).map(([key, label, type, autoComplete]) => (
          <div className="field" key={key}>
            <label htmlFor={`new-invite-${key}`}>{t(label)}</label>
            <input
              id={`new-invite-${key}`}
              type={type}
              autoComplete={autoComplete}
              value={form[key]}
              required
              maxLength={key === "email" ? 254 : 100}
              disabled={busy}
              onChange={(event) =>
                setForm({ ...form, [key]: event.target.value })
              }
            />
          </div>
        ))}
        <div className="row">
          <button disabled={busy}>
            {busy ? t("Sending…") : t("Send invitation")}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={onClose}
          >
            {t("Cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PendingInvites({ reloadTick }: { reloadTick: number }) {
  const { t } = useTranslation();
  const gymApi = useGymApi();
  const formatDate = useDateFormatter();
  const [invites, setInvites] = useState<MemberInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resending, setResending] = useState<string | null>(null);
  const busy = useRef(false);
  const [cancelling, setCancelling] = useState<MemberInvite | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api<MemberInviteListResponse>(gymApi("/invites"), {
      signal: controller.signal,
    })
      .then((result) => {
        setInvites(result);
        setError("");
      })
      .catch((err) => {
        if (!isAbortError(err))
          setError(errorMessage(err, t, "Could not load invitations."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [gymApi, reloadTick, refresh, t]);

  async function resend(invite: MemberInvite) {
    if (busy.current) return;
    busy.current = true;
    setResending(invite.id);
    setError("");
    setNotice("");
    try {
      await api<MemberInvite>(gymApi(`/invites/${invite.id}/resend`), {
        method: "POST",
      });
      setNotice(t("Invitation resent. The previous link no longer works."));
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(errorMessage(err, t, "Could not resend the invitation."));
    } finally {
      setResending(null);
      busy.current = false;
    }
  }

  return (
    <section
      className="panel"
      style={{ margin: "24px 0" }}
      aria-label={t("Pending invites")}
    >
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>{t("Pending invites")}</h2>
        <button
          type="button"
          className="ghost"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t("Refresh")}
        </button>
      </div>
      <p className="hint">
        {t("Only invitations for the selected gym are shown.")}
      </p>
      {error && (
        <div className="msg error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="msg success" role="status">
          {notice}
        </div>
      )}
      {loading ? (
        <p className="hint">{t("Loading…")}</p>
      ) : invites.length === 0 ? (
        <p className="hint">{t("No pending invitations.")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("Full name")}</th>
                <th>{t("Email")}</th>
                <th>{t("Created by")}</th>
                <th>{t("Created")}</th>
                <th>{t("Expires")}</th>
                <th>{t("Resends")}</th>
                <th>{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id}>
                  <td>
                    {invite.firstName} {invite.lastName}
                  </td>
                  <td>{invite.email}</td>
                  <td>{invite.createdByName || "—"}</td>
                  <td>{formatDate(invite.createdAt)}</td>
                  <td>{formatDate(invite.expiresAt)}</td>
                  <td>{invite.resendCount}/5</td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        className="ghost"
                        disabled={!!resending || invite.resendCount >= 5}
                        onClick={() => void resend(invite)}
                      >
                        {resending === invite.id
                          ? t("Sending…")
                          : t("Resend invitation")}
                      </button>
                      <button
                        type="button"
                        className="ghost danger"
                        disabled={!!resending}
                        onClick={() => setCancelling(invite)}
                      >
                        {t("Cancel invitation")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cancelling && (
        <ConfirmModal
          title={t("Cancel invitation")}
          confirmLabel={t("Cancel invitation")}
          danger
          errorFallback="Could not cancel the invitation."
          onClose={() => setCancelling(null)}
          onConfirm={async () => {
            await api(gymApi(`/invites/${cancelling.id}`), {
              method: "DELETE",
            });
            setCancelling(null);
            setNotice(t("Invitation cancelled."));
            setRefresh((value) => value + 1);
          }}
        >
          <p>
            {t(
              "Cancel the invitation for {{name}}? The email link will stop working.",
              { name: `${cancelling.firstName} ${cancelling.lastName}` },
            )}
          </p>
        </ConfirmModal>
      )}
    </section>
  );
}
