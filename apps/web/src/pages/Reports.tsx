import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EntryTrend, ReportSummary } from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import { dateInputValue, rangeBounds } from "../lib/dateRange";
import { useProfile } from "../lib/profile";

const DAY_MS = 24 * 60 * 60 * 1000;

function KpiCard({
  label,
  value,
  delta,
  color,
}: {
  label: string;
  value: string;
  delta?: string;
  color?: string;
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {delta && <div className="kpi-delta">{delta}</div>}
    </div>
  );
}

function TrendChart({ trend }: { trend: EntryTrend }) {
  const { t } = useTranslation();
  const peak = Math.max(...trend.points.map((p) => p.total), 0);

  if (peak === 0) {
    return <p className="hint">{t("Bu aralıkta geçiş kaydı yok.")}</p>;
  }

  return (
    <div className="trend-chart">
      {trend.points.map((point) => (
        <div
          className="trend-bar-slot"
          key={point.date}
          // Tarayıcı ipucu: nokta sayısı çoğaldıkça eksen etiketleri
          // okunamaz hâle gelir, değerler başlıkta kalır.
          title={`${point.date} · ${point.total} (${point.allowed}/${point.denied})`}
        >
          <div
            className="trend-bar"
            style={{ height: `${(point.total / peak) * 100}%` }}
          >
            <div
              className="trend-bar-denied"
              style={{
                height:
                  point.total > 0
                    ? `${(point.denied / point.total) * 100}%`
                    : "0%",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Reports() {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  const { profile } = useProfile();
  const today = dateInputValue(new Date());

  const [from, setFrom] = useState(
    dateInputValue(new Date(Date.now() - 30 * DAY_MS)),
  );
  const [to, setTo] = useState(today);
  // Girdiler yazılırken değil "Uygula" ile sorgulanır; her tuş vuruşunda
  // toplulaştırma çalıştırmak sunucuyu boş yere yorar.
  const [applied, setApplied] = useState({ from, to });

  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [trend, setTrend] = useState<EntryTrend | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const bounds = rangeBounds(applied.from, applied.to);
      if (!bounds) {
        setError(
          t(
            "Aralık geçersiz. Başlangıç bitişten sonra olamaz ve aralık 366 günü aşamaz.",
          ),
        );
        setLoading(false);
        return;
      }
      setLoading(true);
      const query = new URLSearchParams(bounds).toString();
      try {
        const [nextSummary, nextTrend] = await Promise.all([
          api<ReportSummary>(`/api/admin/reports/summary?${query}`, { signal }),
          api<EntryTrend>(`/api/admin/reports/entry-trend?${query}`, {
            signal,
          }),
        ]);
        setSummary(nextSummary);
        setTrend(nextTrend);
        setError(null);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(errorMessage(err, t, "Yüklenemedi."));
      } finally {
        // İptal edilen isteğin finally'si yerine geçen isteğin yükleme
        // durumunu silmemeli; aksi halde hızlı aralık değişiminde arayüz
        // istek sürerken "bitti" görünür.
        if (!signal.aborted) setLoading(false);
      }
    },
    [applied, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function applyPreset(days: number) {
    const nextFrom = dateInputValue(new Date(Date.now() - days * DAY_MS));
    setFrom(nextFrom);
    setTo(today);
    setApplied({ from: nextFrom, to: today });
  }

  const bounds = rangeBounds(applied.from, applied.to);
  const exportHref = (dataset: string) =>
    bounds
      ? `/api/admin/reports/export?${new URLSearchParams({ dataset, ...bounds }).toString()}`
      : undefined;

  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  return (
    <div className="stagger">
      <h1>{t("Raporlar")}</h1>

      <div className="panel">
        <div className="row" style={{ alignItems: "flex-end", gap: 16 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="report-from">{t("Başlangıç")}</label>
            <input
              id="report-from"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="report-to">{t("Bitiş")}</label>
            <input
              id="report-to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <button onClick={() => setApplied({ from, to })} disabled={loading}>
            {t("Uygula")}
          </button>
          <button className="ghost" onClick={() => applyPreset(7)}>
            {t("Son 7 gün")}
          </button>
          <button className="ghost" onClick={() => applyPreset(30)}>
            {t("Son 30 gün")}
          </button>
          <button className="ghost" onClick={() => applyPreset(90)}>
            {t("Son 90 gün")}
          </button>
        </div>
      </div>

      {error && <div className="msg error">{error}</div>}

      <div className="kpi-grid">
        <KpiCard
          label={t("Yeni Üye")}
          value={summary ? number(summary.newMembers) : "—"}
          delta={t("aralıkta kaydolan")}
        />
        <KpiCard
          label={t("Yeni Abonelik")}
          value={summary ? number(summary.newSubscriptions) : "—"}
          delta={t("aralıkta eklenen")}
        />
        <KpiCard
          label={t("Kaybedilen Üye")}
          value={summary ? number(summary.lapsedMembers) : "—"}
          delta={t("aralıkta bitip yenilemeyen")}
          color="var(--danger)"
        />
        <KpiCard
          label={t("Yenileme Bekleyen")}
          value={summary ? number(summary.renewalsDue) : "—"}
          delta={t("7 gün içinde")}
          color="var(--warn)"
        />
      </div>

      <div className="kpi-grid cols-3">
        <KpiCard
          label={t("Aktif Üye")}
          value={summary ? number(summary.activeMembers) : "—"}
          delta={t("aktif abonelik")}
        />
        <KpiCard
          label={t("Geçiş Sayısı")}
          value={summary ? number(summary.entries.total) : "—"}
          delta={
            summary
              ? t("{{allowed}} izin · {{denied}} red", {
                  allowed: summary.entries.allowed,
                  denied: summary.entries.denied,
                })
              : undefined
          }
        />
        <KpiCard
          label={t("Benzersiz üye")}
          value={summary ? number(summary.entries.uniqueMembers) : "—"}
          delta={t("aralıkta en az bir geçiş")}
        />
      </div>

      <div className="panel">
        <h2>{t("Günlük Giriş Trendi")}</h2>
        {loading && !trend && <p className="hint">{t("Yükleniyor…")}</p>}
        {trend && <TrendChart trend={trend} />}
      </div>

      {profile?.role === "admin" && bounds && (
        <div className="panel">
          <h2>{t("Dışa Aktar")}</h2>
          <p className="hint" style={{ marginBottom: 14 }}>
            {t(
              "Dışa aktarılan dosyalar kişisel veri içerir ve her indirme işlem kaydına yazılır.",
            )}
          </p>
          <div className="row" style={{ gap: 12 }}>
            {/* api() JSON çözer; CSV doğrudan bağlantıyla indirilir — oturum
                çerezi tarayıcı tarafından zaten gönderilir. */}
            <a className="button ghost" href={exportHref("members")} download>
              {t("Üyeler (CSV)")}
            </a>
            <a
              className="button ghost"
              href={exportHref("subscriptions")}
              download
            >
              {t("Abonelikler (CSV)")}
            </a>
            <a className="button ghost" href={exportHref("entries")} download>
              {t("Geçişler (CSV)")}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
