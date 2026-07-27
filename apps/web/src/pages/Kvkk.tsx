import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeletionRequest, Page } from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import type { WebTranslationKey } from "../i18n/resources";

const statusMeta: Record<
  DeletionRequest["status"],
  { cls: string; label: WebTranslationKey }
> = {
  pending: { cls: "warn", label: "Bekliyor" },
  approved: { cls: "ok", label: "Onaylandı" },
  rejected: { cls: "danger", label: "Reddedildi" },
};

export function Kvkk() {
  const { t, i18n } = useTranslation();
  const [requests, setRequests] = useState<DeletionRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** `cursor` yoksa ilk sayfa (liste sıfırlanır), varsa sonraki sayfa eklenir. */
  const load = useCallback(
    async (cursor: string | null, signal?: AbortSignal) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (status) params.set("status", status);
      try {
        const page = await api<Page<DeletionRequest>>(
          `/api/admin/deletion-requests?${params.toString()}`,
          { signal },
        );
        setRequests((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(errorMessage(err, t, "Yüklenemedi."));
      } finally {
        setLoading(false);
      }
    },
    [status, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  async function approve(r: DeletionRequest) {
    const who = r.name || r.email || t("Bu üyenin");
    if (
      !confirm(
        t(
          "{{who}} hesabı ve tüm ilişkili verileri kalıcı olarak silinecek. Bu işlem geri alınamaz. Onaylıyor musunuz?",
          { who },
        ),
      )
    ) {
      return;
    }
    setBusyId(r.id);
    setError(null);
    try {
      await api(`/api/admin/deletion-requests/${r.id}/approve`, {
        method: "POST",
      });
      await load(null);
    } catch (err) {
      setError(errorMessage(err, t, "İşlem başarısız."));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(r: DeletionRequest) {
    setBusyId(r.id);
    setError(null);
    try {
      await api(`/api/admin/deletion-requests/${r.id}/reject`, {
        method: "POST",
      });
      await load(null);
    } catch (err) {
      setError(errorMessage(err, t, "İşlem başarısız."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="stagger">
      <h1>{t("KVKK silme talepleri")}</h1>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="kvkk-status">{t("Durum")}</label>
          <select
            id="kvkk-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t("Tümü")}</option>
            {Object.entries(statusMeta).map(([value, meta]) => (
              <option key={value} value={value}>
                {t(meta.label)}
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
              <th>{t("Üye")}</th>
              <th>{t("E-posta")}</th>
              <th>{t("Talep tarihi")}</th>
              <th>{t("Durum")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td>{r.name || "—"}</td>
                <td>{r.email || "—"}</td>
                <td>
                  {new Date(r.requestedAt).toLocaleDateString(
                    dateLocale(i18n.resolvedLanguage),
                  )}
                </td>
                <td>
                  <span className={`badge ${statusMeta[r.status].cls}`}>
                    {t(statusMeta[r.status].label)}
                  </span>
                </td>
                <td>
                  {r.status === "pending" && (
                    <div className="row">
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => void approve(r)}
                      >
                        {t("Onayla")}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busyId === r.id}
                        onClick={() => void reject(r)}
                      >
                        {t("Reddet")}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {requests.length === 0 && !error && !loading && (
              <tr>
                <td colSpan={5}>{t("Talep yok.")}</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={5}>{t("Yükleniyor…")}</td>
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
