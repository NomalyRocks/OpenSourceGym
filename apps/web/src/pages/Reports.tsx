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
    return <p className="hint">{t("No entries in this range.")}</p>;
  }

  return (
    <div className="trend-chart">
      {trend.points.map((point) => (
        <div
          className="trend-bar-slot"
          key={point.date}
          // Browser tooltip: as the number of points grows, axis labels become
          // unreadable, while the values remain available in the title.
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
  // Query inputs on "Apply," not while typing; running aggregation on every
  // keystroke would burden the server unnecessarily.
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
            "Invalid range. Start cannot be after end and the range cannot exceed 366 days.",
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
        setError(errorMessage(err, t, "Could not load data."));
      } finally {
        // The canceled request's finally block must not clear the replacement
        // request's loading state; otherwise, rapid range changes make the UI
        // appear finished while the request is still in progress.
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
      <h1>{t("Reports")}</h1>

      <div className="panel">
        <div className="row" style={{ alignItems: "flex-end", gap: 16 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="report-from">{t("Start")}</label>
            <input
              id="report-from"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="report-to">{t("End")}</label>
            <input
              id="report-to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <button onClick={() => setApplied({ from, to })} disabled={loading}>
            {t("Apply")}
          </button>
          <button className="ghost" onClick={() => applyPreset(7)}>
            {t("Last 7 days")}
          </button>
          <button className="ghost" onClick={() => applyPreset(30)}>
            {t("Last 30 days")}
          </button>
          <button className="ghost" onClick={() => applyPreset(90)}>
            {t("Last 90 days")}
          </button>
        </div>
      </div>

      {error && <div className="msg error">{error}</div>}

      <div className="kpi-grid">
        <KpiCard
          label={t("New members")}
          value={summary ? number(summary.newMembers) : "—"}
          delta={t("joined in range")}
        />
        <KpiCard
          label={t("New subscriptions")}
          value={summary ? number(summary.newSubscriptions) : "—"}
          delta={t("added in range")}
        />
        <KpiCard
          label={t("Lapsed members")}
          value={summary ? number(summary.lapsedMembers) : "—"}
          delta={t("expired without renewal")}
          color="var(--danger)"
        />
        <KpiCard
          label={t("Renewals due")}
          value={summary ? number(summary.renewalsDue) : "—"}
          delta={t("within 7 days")}
          color="var(--warn)"
        />
      </div>

      <div className="kpi-grid cols-3">
        <KpiCard
          label={t("Active members")}
          value={summary ? number(summary.activeMembers) : "—"}
          delta={t("active subscriptions")}
        />
        <KpiCard
          label={t("Entry count")}
          value={summary ? number(summary.entries.total) : "—"}
          delta={
            summary
              ? t("{{allowed}} allowed · {{denied}} denied", {
                  allowed: summary.entries.allowed,
                  denied: summary.entries.denied,
                })
              : undefined
          }
        />
        <KpiCard
          label={t("Unique members")}
          value={summary ? number(summary.entries.uniqueMembers) : "—"}
          delta={t("at least one entry in range")}
        />
      </div>

      <div className="panel">
        <h2>{t("Daily entry trend")}</h2>
        {loading && !trend && <p className="hint">{t("Loading…")}</p>}
        {trend && <TrendChart trend={trend} />}
      </div>

      {profile?.role === "admin" && bounds && (
        <div className="panel">
          <h2>{t("Export")}</h2>
          <p className="hint" style={{ marginBottom: 14 }}>
            {t(
              "Exported files contain personal data and every download is written to the audit log.",
            )}
          </p>
          <div className="row" style={{ gap: 12 }}>
            {/* api() parses JSON; CSV is downloaded through a direct link — the
                browser already sends the session cookie. */}
            <a className="button ghost" href={exportHref("members")} download>
              {t("Members (CSV)")}
            </a>
            <a
              className="button ghost"
              href={exportHref("subscriptions")}
              download
            >
              {t("Subscriptions (CSV)")}
            </a>
            <a className="button ghost" href={exportHref("entries")} download>
              {t("Entries (CSV)")}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
