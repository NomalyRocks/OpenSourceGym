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

function roleKey(role: PublicUser["role"]): "Yönetici" | "Personel" | "Üye" {
  if (role === "admin") return "Yönetici";
  if (role === "staff") return "Personel";
  return "Üye";
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
    ) || "Ü";
  return (
    <span className={`member-avatar${large ? " member-avatar-large" : ""}`}>
      {member.profilePhotoUrl && !failed ? (
        <img
          src={member.profilePhotoUrl}
          alt={t("{{name}} profil fotoğrafı", {
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
    return { label: "Planlandı", className: "warn" };
  }
  if (new Date(subscription.endsAt).getTime() >= now) {
    return { label: "Aktif", className: "ok" };
  }
  return { label: "Bitti", className: "member" };
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

  // Yükleme render fazında değil burada yapılır: render sırasında istek atmak
  // StrictMode'da çift istek ve unmount sonrası setState üretiyordu.
  useEffect(() => {
    const controller = new AbortController();
    setSubs(null);
    setLoading(true);
    setLoadError(null);

    load(controller.signal)
      .then(setSubs)
      .catch((err) => {
        if (isAbortError(err)) return;
        setLoadError(errorMessage(err, t, "Yüklenemedi."));
      })
      .finally(() => setLoading(false));

    // Üye değişince veya bileşen sökülünce uçuşan istek iptal edilir; geç
    // dönen yanıt yeni üyenin listesini ezemez.
    return () => controller.abort();
  }, [member.id]);

  async function grant() {
    setMsg(null);
    try {
      const request: CreateSubscriptionRequest = {
        userId: member.id,
        months,
        note: t("{{months}} aylık paket", { months }),
      };
      await api("/api/admin/subscriptions", {
        method: "POST",
        body: request,
      });
      setMsg({ kind: "success", text: t("Abonelik tanımlandı.") });
      setSubs(await load());
    } catch (err) {
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Abonelik tanımlanamadı."),
      });
    }
  }

  return (
    <div className="panel">
      <div className="member-detail-heading">
        <MemberAvatar member={member} large />
        <h2>
          {t("Abonelik — {{name}}", {
            name: `${member.firstName} ${member.lastName}`,
          })}
        </h2>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      {loadError && <div className="msg error">{loadError}</div>}
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="field">
          <label htmlFor="months">{t("Paket")}</label>
          <select
            id="months"
            value={months}
            onChange={(e) =>
              setMonths(Number(e.target.value) as SubscriptionMonths)
            }
          >
            {subscriptionMonthOptions.map((option) => (
              <option key={option} value={option}>
                {t(`${option} ay` as "1 ay" | "3 ay" | "6 ay" | "12 ay")}
              </option>
            ))}
          </select>
        </div>
        <button onClick={grant}>{t("Abonelik tanımla")}</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>{t("Başlangıç")}</th>
            <th>{t("Bitiş")}</th>
            <th>{t("Not")}</th>
            <th>{t("Durum")}</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={4}>{t("Yükleniyor…")}</td>
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
              <td colSpan={4}>{t("Abonelik kaydı yok.")}</td>
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
        text: t("Aramak için en az iki karakter girin."),
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
        text: errorMessage(err, t, "Arama başarısız."),
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
      text: t("{{email}} → {{role}} olarak güncellendi.", {
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
        text: errorMessage(err, t, "Rol atanamadı."),
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
        setMfaInfo(t("Kod e-postanıza gönderildi."));
      } catch (err) {
        setMfaError(errorMessage(err, t, "Kod gönderilemedi."));
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
        setMfaError(t("Kod geçersiz."));
      } else {
        setMfaError(errorMessage(err, t, "Doğrulama başarısız."));
      }
    } finally {
      setMfaBusy(false);
    }
  }

  return (
    <div className="stagger">
      <h1>{t("Üyeler")}</h1>
      <div className="panel">
        <form className="row" onSubmit={search}>
          <div className="field">
            <label htmlFor="member-query">
              {t("Telefon, e-posta, ad veya soyad")}
            </label>
            <input
              id="member-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("Ayşe Yılmaz, ayse@… veya +90530…")}
              minLength={2}
              required
            />
          </div>
          <button type="submit">{t("Ara")}</button>
        </form>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      {results && (
        <div className="panel">
          <h2>{t("Sonuçlar")}</h2>
          <table>
            <thead>
              <tr>
                <th>{t("Ad Soyad")}</th>
                <th>{t("Telefon")}</th>
                <th>{t("E-posta")}</th>
                <th>{t("Rol")}</th>
                <th>{t("İşlem")}</th>
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
                          <option value="member">{t("Üye")}</option>
                          <option value="staff">{t("Personel")}</option>
                          <option value="admin">{t("Yönetici")}</option>
                        </select>
                      )}
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setSelected(u)}
                      >
                        {t("Abonelik")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr>
                  <td colSpan={5}>{t("Eşleşen üye bulunamadı.")}</td>
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
            <h2>{t("MFA doğrulama gerekli")}</h2>
            <p className="hint" style={{ marginBottom: 16 }}>
              {t(
                "{{email}} kullanıcısının rolünü {{role}} olarak değiştirmek için doğrulama kodu girin.",
                {
                  email: mfaPrompt.target.email,
                  role: t(roleKey(mfaPrompt.role as PublicUser["role"])),
                },
              )}
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
                {t("E-posta kodu")}
              </button>
            </div>
            <div className="field">
              <label htmlFor="mfaCode">{t("Doğrulama kodu")}</label>
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
                {mfaBusy ? t("Doğrulanıyor…") : t("Onayla")}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setMfaPrompt(null)}
                disabled={mfaBusy}
              >
                {t("Vazgeç")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
