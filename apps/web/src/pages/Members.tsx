import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CreateSubscriptionRequest,
  MfaMethod,
  PublicUser,
  Subscription,
  SubscriptionMonths,
} from "@opengym/shared";
import { ApiError, api, authApi, isAbortError } from "../lib/api";
import { useProfile } from "../lib/profile";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import type { WebTranslationKey } from "../i18n/resources";

const subscriptionMonthOptions: readonly SubscriptionMonths[] = [1, 3, 6, 12];

function roleKey(
  role: PublicUser["role"],
): "Administrator" | "Staff" | "Member" {
  if (role === "admin") return "Administrator";
  if (role === "staff") return "Staff";
  return "Member";
}

const monthsKeys = {
  1: "1 month",
  3: "3 months",
  6: "6 months",
  12: "12 months",
} as const satisfies Record<SubscriptionMonths, WebTranslationKey>;

function monthsKey(months: SubscriptionMonths): WebTranslationKey {
  return monthsKeys[months];
}

function MemberAvatar({
  member,
  large = false,
}: {
  member: PublicUser;
  large?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [failed, setFailed] = useState(false);
  const initials =
    `${member.firstName[0] ?? ""}${member.lastName[0] ?? ""}`.toLocaleUpperCase(
      dateLocale(i18n.resolvedLanguage),
    ) || "?";
  return (
    <span className={`member-avatar${large ? " member-avatar-large" : ""}`}>
      {member.profilePhotoUrl && !failed ? (
        <img
          src={member.profilePhotoUrl}
          alt={t("Profile photo of {{name}}", {
            name: `${member.firstName} ${member.lastName}`,
          })}
          onError={() => setFailed(true)}
        />
      ) : (
        initials
      )}
    </span>
  );
}

function subscriptionStatus(subscription: Subscription): {
  label: WebTranslationKey;
  className: string;
} {
  const now = Date.now();
  if (new Date(subscription.startsAt).getTime() > now) {
    return { label: "Scheduled", className: "warn" };
  }
  if (new Date(subscription.endsAt).getTime() >= now) {
    return { label: "Active", className: "ok" };
  }
  return { label: "Expired", className: "member" };
}

function SubscriptionPanel({ member }: { member: PublicUser }) {
  const { t, i18n } = useTranslation();
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  const [months, setMonths] = useState<SubscriptionMonths>(1);

  function load(signal?: AbortSignal) {
    return api<Subscription[]>(`/api/admin/users/${member.id}/subscriptions`, {
      signal,
    });
  }

  // Load here instead of during the render phase: requesting during render caused
  // duplicate requests in StrictMode and setState calls after unmount.
  useEffect(() => {
    const controller = new AbortController();
    setSubs(null);
    setLoading(true);
    setLoadError(null);

    load(controller.signal)
      .then(setSubs)
      .catch((err) => {
        if (isAbortError(err)) return;
        setLoadError(errorMessage(err, t, "Could not load data."));
      })
      .finally(() => setLoading(false));

    // Cancel the in-flight request when the member changes or the component
    // unmounts, so a late response cannot overwrite the new member's list.
    return () => controller.abort();
  }, [member.id]);

  async function grant() {
    setMsg(null);
    try {
      const request: CreateSubscriptionRequest = {
        userId: member.id,
        months,
        note: t("{{months}}-month plan", { months }),
      };
      await api("/api/admin/subscriptions", {
        method: "POST",
        body: request,
      });
      setMsg({ kind: "success", text: t("Subscription granted.") });
      setSubs(await load());
    } catch (err) {
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Could not grant the subscription."),
      });
    }
  }

  return (
    <div className="panel">
      <div className="member-detail-heading">
        <MemberAvatar member={member} large />
        <h2>
          {t("Subscription — {{name}}", {
            name: `${member.firstName} ${member.lastName}`,
          })}
        </h2>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      {loadError && <div className="msg error">{loadError}</div>}
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="field">
          <label htmlFor="months">{t("Plan")}</label>
          <select
            id="months"
            value={months}
            onChange={(e) =>
              setMonths(Number(e.target.value) as SubscriptionMonths)
            }
          >
            {subscriptionMonthOptions.map((option) => (
              <option key={option} value={option}>
                {t(monthsKey(option))}
              </option>
            ))}
          </select>
        </div>
        <button onClick={grant}>{t("Grant subscription")}</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>{t("Start")}</th>
            <th>{t("End")}</th>
            <th>{t("Note")}</th>
            <th>{t("Status")}</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={4}>{t("Loading…")}</td>
            </tr>
          )}
          {!loading &&
            (subs ?? []).map((subscription) => {
              const status = subscriptionStatus(subscription);
              return (
                <tr key={subscription.id}>
                  <td>
                    {new Date(subscription.startsAt).toLocaleDateString(
                      dateLocale(i18n.resolvedLanguage),
                    )}
                  </td>
                  <td>
                    {new Date(subscription.endsAt).toLocaleDateString(
                      dateLocale(i18n.resolvedLanguage),
                    )}
                  </td>
                  <td>{subscription.note ?? "—"}</td>
                  <td>
                    <span className={`badge ${status.className}`}>
                      {t(status.label)}
                    </span>
                  </td>
                </tr>
              );
            })}
          {!loading && subs?.length === 0 && (
            <tr>
              <td colSpan={4}>{t("No subscription records.")}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface MfaPrompt {
  target: PublicUser;
  role: string;
}

export function Members() {
  const { t } = useTranslation();
  const { profile: user } = useProfile();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicUser[] | null>(null);
  const [selected, setSelected] = useState<PublicUser | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);

  const [mfaPrompt, setMfaPrompt] = useState<MfaPrompt | null>(null);
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>("totp");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaInfo, setMfaInfo] = useState<string | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setSelected(null);
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setMsg({
        kind: "error",
        text: t("Enter at least two characters to search."),
      });
      return;
    }
    try {
      setResults(
        await api<PublicUser[]>(`/api/admin/users?q=${encodeURIComponent(q)}`),
      );
    } catch (err) {
      setResults(null);
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Search failed."),
      });
    }
  }

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
    setResults(
      (prev) =>
        prev?.map((u) =>
          u.id === target.id ? { ...u, role: role as PublicUser["role"] } : u,
        ) ?? null,
    );
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

  return (
    <div className="stagger">
      <h1>{t("Members")}</h1>
      <div className="panel">
        <form className="row" onSubmit={search}>
          <div className="field">
            <label htmlFor="member-query">
              {t("Phone, email, first or last name")}
            </label>
            <input
              id="member-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Jane Smith, jane@… or +1202…")}
              minLength={2}
              required
            />
          </div>
          <button type="submit">{t("Search")}</button>
        </form>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      {results && (
        <div className="panel">
          <h2>{t("Results")}</h2>
          <table>
            <thead>
              <tr>
                <th>{t("Full name")}</th>
                <th>{t("Phone")}</th>
                <th>{t("Email")}</th>
                <th>{t("Role")}</th>
                <th>{t("Action")}</th>
              </tr>
            </thead>
            <tbody>
              {results.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="member-identity">
                      <MemberAvatar member={u} />
                      <span>
                        {u.firstName} {u.lastName}
                      </span>
                    </div>
                  </td>
                  <td>{u.phone}</td>
                  <td>{u.email}</td>
                  <td>
                    <span className={`badge ${u.role}`}>
                      {t(roleKey(u.role))}
                    </span>
                  </td>
                  <td>
                    <div className="row">
                      {user?.role === "admin" && u.id !== user.id && (
                        <select
                          value={u.role}
                          onChange={(e) => setRole(u, e.target.value)}
                        >
                          <option value="member">{t("Member")}</option>
                          <option value="staff">{t("Staff")}</option>
                          <option value="admin">{t("Administrator")}</option>
                        </select>
                      )}
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setSelected(u)}
                      >
                        {t("Subscription")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr>
                  <td colSpan={5}>{t("No matching member found.")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {selected && <SubscriptionPanel key={selected.id} member={selected} />}
      {mfaPrompt && (
        <div className="modal-overlay">
          <div className="panel">
            <h2>{t("MFA verification required")}</h2>
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
          </div>
        </div>
      )}
    </div>
  );
}
