import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CashReport, CashReportPayment } from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { useGymApi } from "../lib/gyms";
import { formatMoney } from "../lib/money";
import { reportDayRange } from "../lib/reportDayRange";
import { dayStartIso } from "../lib/dateRange";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import { PageHeader } from "../components/PageHeader";
import { useDateFormatter } from "../components/Modal";
import { paymentMethodKeys } from "../components/PaymentFields";

function PaymentTable({
  items,
  timeZone,
}: {
  items: CashReportPayment[];
  timeZone: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t("Time")}</th>
            <th>{t("Member")}</th>
            <th>{t("Package")}</th>
            <th>{t("Payment amount")}</th>
            <th>{t("Payment method")}</th>
            <th>{t("Recorded by")}</th>
            <th>{t("Note")}</th>
            <th>{t("Void reason")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>
                {new Date(p.paidAt).toLocaleTimeString(locale, { timeZone })}
              </td>
              <td>{p.memberName ?? t("Deleted member")}</td>
              <td>{p.packageName}</td>
              <td className={p.void ? "payment-voided" : "money-cell"}>
                {formatMoney(p.amountMinor, p.currency, locale)}
              </td>
              <td>{t(paymentMethodKeys[p.method])}</td>
              <td>{p.recordedByName ?? p.recordedBy}</td>
              <td>{p.note || "—"}</td>
              <td>{p.void?.reason || "—"}</td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={8}>{t("No payments.")}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Cash() {
  const { t, i18n } = useTranslation();
  const formatDate = useDateFormatter();
  const gymApi = useGymApi();
  // Let the server choose today's day in REPORTS_TIME_ZONE on the first load.
  const [day, setDay] = useState("");
  const [report, setReport] = useState<CashReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setReport(null);
    api<CashReport>(
      gymApi(`/reports/cash${day ? `?day=${encodeURIComponent(day)}` : ""}`),
      { signal: controller.signal },
    )
      .then(setReport)
      .catch((err) => {
        if (!isAbortError(err))
          setError(errorMessage(err, t, "Could not load data."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [day, gymApi, t, version]);
  const locale = dateLocale(i18n.resolvedLanguage);
  const selectedDay = day || report?.day || "";
  const selectedDayIso = dayStartIso(selectedDay);
  const bounds = report ? reportDayRange(report.day, report.timeZone) : null;
  const exportHref = bounds
    ? gymApi(
        `/reports/export?${new URLSearchParams({ dataset: "payments", ...bounds })}`,
      )
    : undefined;
  return (
    <div className="stagger">
      <PageHeader
        title={t("Daily cash")}
        subtitle={t("Payments recorded at this gym, excluding voided records.")}
      />
      <div className="panel">
        <div className="row">
          <div className="field">
            <label htmlFor="cash-day">{t("Day")}</label>
            <input
              id="cash-day"
              type="date"
              value={selectedDay}
              onChange={(e) => setDay(e.target.value)}
              aria-describedby={selectedDayIso ? "cash-day-hint" : undefined}
            />
            {selectedDayIso && (
              <span className="hint" id="cash-day-hint">
                {formatDate(selectedDayIso)}
              </span>
            )}
          </div>
          <button
            className="ghost"
            disabled={loading}
            onClick={() => setVersion((v) => v + 1)}
          >
            {t("Refresh")}
          </button>
          {exportHref && (
            <a className="button ghost" href={exportHref} download>
              {t("Payments (CSV)")}
            </a>
          )}
        </div>
        {report && (
          <p className="hint">
            {t("Report time zone")}: {report.timeZone}
          </p>
        )}
      </div>
      {error && <div className="msg error">{error}</div>}
      {loading && <p className="hint">{t("Loading…")}</p>}
      {report && (
        <>
          {report.truncated && (
            <div className="msg warn">
              {t("List shortened — use the CSV export for every row")}
            </div>
          )}
          {report.totals.length === 0 && (
            <div className="panel">
              <p className="hint">{t("No payments.")}</p>
            </div>
          )}
          <div className="kpi-grid">
            {report.totals.map((total) => (
              <div className="kpi-card" key={total.currency}>
                <div className="kpi-label">
                  {t("Total")} · {total.currency}
                </div>
                <div className="kpi-value">
                  {formatMoney(total.totalMinor, total.currency, locale)}
                </div>
                <div className="kpi-delta">
                  {t("{{count}} payments", { count: total.count })}
                </div>
              </div>
            ))}
          </div>
          {report.totals.map((total) => (
            <div className="cash-breakdowns" key={total.currency}>
              <div className="panel">
                <h2>
                  {t("By method")} · {total.currency}
                </h2>
                <div className="list">
                  {total.byMethod.map((row) => (
                    <div className="list-row" key={row.method}>
                      <span>
                        {t(paymentMethodKeys[row.method])} · {row.count}
                      </span>
                      <strong className="money-cell">
                        {formatMoney(row.totalMinor, total.currency, locale)}
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="panel">
                <h2>
                  {t("By staff")} · {total.currency}
                </h2>
                <div className="list">
                  {total.byStaff.map((row) => (
                    <div className="list-row" key={row.userId}>
                      <span>
                        {row.name ?? row.userId} · {row.count}
                      </span>
                      <strong className="money-cell">
                        {formatMoney(row.totalMinor, total.currency, locale)}
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
          <div className="panel">
            <h2>{t("Payments")}</h2>
            <PaymentTable items={report.payments} timeZone={report.timeZone} />
          </div>
          <div className="panel">
            <h2>{t("Voided payments")}</h2>
            <PaymentTable items={report.voided} timeZone={report.timeZone} />
          </div>
        </>
      )}
    </div>
  );
}
