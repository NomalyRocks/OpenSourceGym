import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Page,
  RenewalDueMember,
  RenewalReminderResult,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";

const WINDOWS = [7, 14, 30, 90];

export function Renewals() {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  const [members, setMembers] = useState<RenewalDueMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [withinDays, setWithinDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendingFor, setSendingFor] = useState<string | null>(null);

  /**
   * `cursor` verilmezse ilk sayfa (liste sıfırlanır), verilirse sonraki sayfa
   * eklenir. Pencere değişince imleç geçersizdir, bu yüzden baştan yüklenir.
   */
  const load = useCallback(
    async (cursor: string | null, signal?: AbortSignal) => {
      setLoading(true);
      const params = new URLSearchParams({ withinDays: String(withinDays) });
      if (cursor) params.set("cursor", cursor);
      try {
        const page = await api<Page<RenewalDueMember>>(
          `/api/admin/reports/renewals?${params.toString()}`,
          { signal },
        );
        setMembers((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(errorMessage(err, t, "Yüklenemedi."));
      } finally {
        setLoading(false);
      }
    },
    [withinDays, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  async function remind(member: RenewalDueMember) {
    setSendingFor(member.userId);
    setNotice(null);
    try {
      const result = await api<RenewalReminderResult>(
        `/api/admin/reports/renewals/${member.userId}/remind`,
        { method: "POST" },
      );
      // Satırı yerinde güncelliyoruz: tüm listeyi yeniden çekmek kullanıcının
      // yüklediği sonraki sayfaları da atardı.
      setMembers((prev) =>
        prev.map((row) =>
          row.userId === member.userId
            ? { ...row, lastReminderAt: result.sentAt }
            : row,
        ),
      );
      setNotice(t("Hatırlatma gönderildi."));
      setError(null);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(errorMessage(err, t, "Yüklenemedi."));
    } finally {
      setSendingFor(null);
    }
  }

  return (
    <div className="stagger">
      <h1>{t("Yenilemeler")}</h1>

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="renewal-window">{t("Kalan gün")}</label>
          <select
            id="renewal-window"
            value={withinDays}
            onChange={(e) => setWithinDays(Number(e.target.value))}
          >
            {WINDOWS.map((days) => (
              <option key={days} value={days}>
                {t("{{days}} gün içinde", { days })}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="msg error">{error}</div>}
      {notice && <div className="msg">{notice}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("Ad Soyad")}</th>
              <th>{t("Telefon")}</th>
              <th>{t("E-posta")}</th>
              <th>{t("Bitiş tarihi")}</th>
              <th>{t("Kalan gün")}</th>
              <th>{t("Son hatırlatma")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td>
                  {member.firstName} {member.lastName}
                </td>
                <td>{member.phone}</td>
                <td>{member.email}</td>
                <td>{new Date(member.endsAt).toLocaleDateString(locale)}</td>
                <td>
                  {member.remainingDays === 0
                    ? t("Bugün")
                    : member.remainingDays}
                </td>
                <td>
                  {member.lastReminderAt
                    ? new Date(member.lastReminderAt).toLocaleString(locale)
                    : t("Hiç")}
                </td>
                <td>
                  <button
                    className="ghost"
                    onClick={() => void remind(member)}
                    disabled={sendingFor !== null}
                  >
                    {sendingFor === member.userId
                      ? t("Gönderiliyor…")
                      : t("Hatırlatma gönder")}
                  </button>
                </td>
              </tr>
            ))}
            {members.length === 0 && !error && !loading && (
              <tr>
                <td colSpan={7}>{t("Yenilemesi yaklaşan üye yok.")}</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7}>{t("Yükleniyor…")}</td>
              </tr>
            )}
          </tbody>
        </table>
        {nextCursor && (
          <button
            onClick={() => void load(nextCursor)}
            disabled={loading}
            style={{ marginTop: 16 }}
          >
            {t("Daha fazla yükle")}
          </button>
        )}
      </div>
    </div>
  );
}
