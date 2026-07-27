import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  EntryEvent,
  GateRejectCode,
  OccupancyResponse,
  Page,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { usePollingQuery } from "../hooks/usePollingQuery";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import type { WebTranslationKey } from "../i18n/resources";

const reasonLabels: Record<GateRejectCode, WebTranslationKey> = {
  INVALID_QR: "Geçersiz kod",
  UNKNOWN_DEVICE: "Bilinmeyen cihaz",
  DEVICE_OFFLINE: "Turnike çevrimdışı",
  NO_ACTIVE_SUBSCRIPTION: "Aktif abonelik yok",
  LOCATION_REQUIRED: "Konum alınamadı",
  OUT_OF_RANGE: "Salon dışı konum",
  MOCK_LOCATION: "Sahte konum",
  SHARING_BLOCKED: "Paylaşım engeli",
};

// Eski akıştan (INVALID_TOKEN/EXPIRED/REPLAY) kalan kayıtlar için ham metne düşer
export function Entries() {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  const reasonLabel = (reason: string | null) => {
    if (!reason) return "—";
    const key = (reasonLabels as Partial<Record<string, WebTranslationKey>>)[
      reason
    ];
    return key ? t(key) : reason;
  };
  const [entries, setEntries] = useState<EntryEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [allowed, setAllowed] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pagedBack, setPagedBack] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildQuery(cursor: string | null): string {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (allowed) params.set("allowed", allowed);
    if (from) params.set("from", new Date(from).toISOString());
    if (to) params.set("to", new Date(to).toISOString());
    return params.toString();
  }

  // Otomatik tazeleme yalnızca ilk sayfayı yeniler. Kullanıcı "daha fazla
  // yükle" ile geçmişe indiyse liste elinden alınmamalı; o durumda yalnızca
  // doluluk sayacı güncellenir.
  async function refresh(signal: AbortSignal) {
    try {
      const occupancyRequest = api<OccupancyResponse>("/api/me/occupancy", {
        signal,
      });
      if (pagedBack) {
        setOccupancy(await occupancyRequest);
        setError(null);
        return;
      }
      const [page, occ] = await Promise.all([
        api<Page<EntryEvent>>(`/api/admin/entry-events?${buildQuery(null)}`, {
          signal,
        }),
        occupancyRequest,
      ]);
      setEntries(page.items);
      setNextCursor(page.nextCursor);
      setOccupancy(occ);
      setError(null);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(errorMessage(err, t, "Yüklenemedi."));
    }
  }

  // Filtre değişince imleç geçersizdir: hook listeyi baştan yükler.
  usePollingQuery(refresh, 10000, `${allowed}|${from}|${to}`);

  /** Filtre değişince sayfalama sıfırlanır: eski imleç yeni filtrede geçersiz. */
  function changeFilter(apply: () => void) {
    apply();
    setPagedBack(false);
    setNextCursor(null);
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<Page<EntryEvent>>(
        `/api/admin/entry-events?${buildQuery(nextCursor)}`,
      );
      setEntries((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
      setPagedBack(true);
      setError(null);
    } catch (err) {
      if (!isAbortError(err)) {
        setError(errorMessage(err, t, "Yüklenemedi."));
      }
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="stagger">
      <h1>{t("Geçişler")}</h1>
      {occupancy && (
        <p className="hint" style={{ marginBottom: 16 }}>
          {t("İçeride: {{count}}", { count: occupancy.inside })}
          {occupancy.ratio != null &&
            ` · ${t("Doluluk: %{{percent}}", {
              percent: Math.round(occupancy.ratio * 100),
            })}`}
        </p>
      )}
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="entries-result">{t("Sonuç")}</label>
          <select
            id="entries-result"
            value={allowed}
            onChange={(e) => changeFilter(() => setAllowed(e.target.value))}
          >
            <option value="">{t("Tümü")}</option>
            <option value="true">{t("İzin verildi")}</option>
            <option value="false">{t("Reddedildi")}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="entries-from">{t("Başlangıç")}</label>
          <input
            id="entries-from"
            type="date"
            value={from}
            onChange={(e) => changeFilter(() => setFrom(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="entries-to">{t("Bitiş")}</label>
          <input
            id="entries-to"
            type="date"
            value={to}
            onChange={(e) => changeFilter(() => setTo(e.target.value))}
          />
        </div>
      </div>
      {error && <div className="msg error">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("Zaman")}</th>
              <th>{t("Cihaz")}</th>
              <th>{t("Üye")}</th>
              <th>{t("Sonuç")}</th>
              <th>{t("Neden")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.at).toLocaleString(locale)}</td>
                <td>{e.deviceName || "—"}</td>
                <td>{e.memberName ?? "—"}</td>
                <td>
                  {e.allowed ? (
                    <span className="badge ok">{t("İzin verildi")}</span>
                  ) : (
                    <span className="badge danger">{t("Reddedildi")}</span>
                  )}
                </td>
                <td>{reasonLabel(e.reason)}</td>
              </tr>
            ))}
            {entries.length === 0 && !error && (
              <tr>
                <td colSpan={5}>{t("Kayıt yok.")}</td>
              </tr>
            )}
          </tbody>
        </table>
        {nextCursor && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            style={{ marginTop: 16 }}
          >
            {t("Daha fazla yükle")}
          </button>
        )}
      </div>
    </div>
  );
}
