import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ChainSummary as ChainSummaryData } from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { usePollingQuery } from "../hooks/usePollingQuery";
import { PageHeader } from "../components/PageHeader";
import { errorMessage } from "../i18n/errors";
import { dateInputValue, rangeBounds } from "../lib/dateRange";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Owner-only "All gyms" overview: per-gym totals plus chain totals. */
export function ChainSummary() {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<ChainSummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const bounds = rangeBounds(
        dateInputValue(new Date(Date.now() - 29 * DAY_MS)),
        dateInputValue(new Date()),
      );
      const query = bounds ? `?${new URLSearchParams(bounds).toString()}` : "";
      try {
        setData(
          await api<ChainSummaryData>(
            `/api/admin/reports/chain/summary${query}`,
            {
              signal,
            },
          ),
        );
        setError(null);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(errorMessage(err, t, "Could not load data."));
      }
    },
    [t],
  );
  usePollingQuery(load, 30000);

  const num = (value: number) =>
    new Intl.NumberFormat(i18n.language).format(value);

  return (
    <div className="stagger">
      <PageHeader
        title={t("All gyms")}
        subtitle={t("Totals for every gym in the chain over the last 30 days.")}
      />
      {error && <div className="msg error">{error}</div>}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">{t("Active members")}</div>
          <div className="kpi-value">
            {data ? num(data.activeMembers) : "—"}
          </div>
          <div className="kpi-delta">{t("across the chain")}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">{t("Inside now")}</div>
          <div className="kpi-value">
            {data ? num(data.gyms.reduce((sum, g) => sum + g.inside, 0)) : "—"}
          </div>
        </div>
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("Gym name")}</th>
              <th>{t("Active members")}</th>
              <th>{t("Renewals due")}</th>
              <th>{t("Inside now")}</th>
              <th>{t("Entries")}</th>
              <th>{t("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.gyms ?? []).map((g) => (
              <tr key={g.gymId}>
                <td>
                  <Link to={`/gyms/${g.gymId}/overview`}>{g.gymName}</Link>
                </td>
                <td>{num(g.activeMembers)}</td>
                <td>{num(g.renewalsDue)}</td>
                <td>{num(g.inside)}</td>
                <td>{num(g.entries.allowed)}</td>
                <td>
                  <span className={`badge ${g.active ? "ok" : "warn"}`}>
                    {g.active ? t("Active") : t("Inactive")}
                  </span>
                </td>
              </tr>
            ))}
            {data && data.gyms.length === 0 && (
              <tr>
                <td colSpan={6}>
                  {t("No gyms yet. Add the first one above.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
