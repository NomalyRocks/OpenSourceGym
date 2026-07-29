import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuditLogEntry, Page } from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import type { WebTranslationKey } from "../i18n/resources";

const actionLabels: Partial<Record<string, WebTranslationKey>> = {
  "sharing-signal": "Paylaşım sinyali",
  "account-sharing-blocked": "Hesap paylaşımı engellendi",
  "profile-photo-updated": "Profil fotoğrafı güncellendi",
  "profile-photo-removed": "Profil fotoğrafı kaldırıldı",
  "kvkk-deletion-requested": "Silme talebi oluşturuldu",
  "kvkk-deletion-cancelled": "Silme talebi iptal edildi",
  "device-created": "Cihaz oluşturuldu",
  "device-deleted": "Cihaz silindi",
  "initial-password-changed": "İlk şifre değiştirildi",
  "role-assigned": "Rol atandı",
  "subscription-created": "Abonelik oluşturuldu",
  "settings-updated": "Ayarlar güncellendi",
  "kvkk-deletion-approved": "Silme talebi onaylandı",
  "kvkk-deletion-rejected": "Silme talebi reddedildi",
  "renewal-reminder-sent": "Yenileme hatırlatması gönderildi",
  "data-exported": "Veri dışa aktarıldı",
};

export function Audit() {
  const { t, i18n } = useTranslation();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * `cursor` verilmezse ilk sayfa (liste sıfırlanır), verilirse sonraki sayfa
   * eklenir. Filtre değişince imleç geçersizdir, bu yüzden baştan yüklenir.
   */
  const load = useCallback(
    async (cursor: string | null, signal?: AbortSignal) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (action) params.set("action", action);
      try {
        const page = await api<Page<AuditLogEntry>>(
          `/api/admin/audit?${params.toString()}`,
          { signal },
        );
        setEntries((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(errorMessage(err, t, "Yüklenemedi."));
      } finally {
        setLoading(false);
      }
    },
    [action, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="stagger">
      <h1>{t("İşlem kaydı")}</h1>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="audit-action">{t("İşlem")}</label>
          <select
            id="audit-action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">{t("Tümü")}</option>
            {Object.entries(actionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label ? t(label) : value}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="msg error">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("Zaman")}</th>
              <th>{t("Kim")}</th>
              <th>{t("İşlem")}</th>
              <th>{t("Detay")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const actionLabel = actionLabels[e.action];
              return (
                <tr key={e.id}>
                  <td>
                    {new Date(e.at).toLocaleString(
                      dateLocale(i18n.resolvedLanguage),
                    )}
                  </td>
                  <td>{e.actorEmail}</td>
                  <td>{actionLabel ? t(actionLabel) : e.action}</td>
                  <td>{e.details ? JSON.stringify(e.details) : "—"}</td>
                </tr>
              );
            })}
            {entries.length === 0 && !error && !loading && (
              <tr>
                <td colSpan={4}>{t("Kayıt yok.")}</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={4}>{t("Yükleniyor…")}</td>
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
