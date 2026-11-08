import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DebtorRow, Page } from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { useGymApi } from "../lib/gyms";
import { formatMoney } from "../lib/money";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import { PageHeader } from "../components/PageHeader";
import { MemberDrawer } from "../components/MemberDrawer";
import { useDateFormatter } from "../components/Modal";

export function Debtors() {
  const { t, i18n } = useTranslation();
  const gymApi = useGymApi();
  const formatDate = useDateFormatter();
  const [rows, setRows] = useState<DebtorRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const load = useCallback(
    async (next: string | null = null) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (next) params.set("cursor", next);
        const page = await api<Page<DebtorRow>>(
          gymApi(`/reports/debtors?${params}`),
          { signal: controller.signal },
        );
        setRows((prev) =>
          next
            ? [
                ...prev,
                ...page.items.filter(
                  (item) =>
                    !prev.some(
                      (row) => row.subscriptionId === item.subscriptionId,
                    ),
                ),
              ]
            : page.items,
        );
        setCursor(page.nextCursor);
      } catch (err) {
        if (!isAbortError(err))
          setError(errorMessage(err, t, "Could not load data."));
      } finally {
        if (inFlight.current === controller) setLoading(false);
      }
    },
    [gymApi, t],
  );
  useEffect(() => {
    void load();
    return () => inFlight.current?.abort();
  }, [load]);
  const changed = useCallback(() => {
    void load();
  }, [load]);
  const locale = dateLocale(i18n.resolvedLanguage);
  return (
    <div className="stagger">
      <PageHeader
        title={t("Debtors")}
        subtitle={t(
          "Outstanding periods, overdue first. A balance never blocks entry.",
        )}
      />
      {error && (
        <div className="msg error">
          {error}
          <button className="ghost" onClick={() => void load()}>
            {t("Retry")}
          </button>
        </div>
      )}
      <div className="panel">
        <div className="row">
          <button
            className="ghost"
            disabled={loading}
            onClick={() => void load()}
          >
            {t("Refresh")}
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("Member")}</th>
                <th>{t("Package")}</th>
                <th>{t("Price")}</th>
                <th>{t("Paid")}</th>
                <th>{t("Balance")}</th>
                <th>{t("Next payment date")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  className="debtor-row"
                  key={row.subscriptionId}
                  onClick={() => setUserId(row.userId)}
                >
                  <td>
                    <button
                      className="ghost member-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        setUserId(row.userId);
                      }}
                    >
                      {row.firstName} {row.lastName}
                    </button>
                    <div className="hint">{row.phone || row.email}</div>
                  </td>
                  <td>
                    {row.packageName}
                    <div className="hint">
                      {formatDate(row.startsAt)} – {formatDate(row.endsAt)}
                    </div>
                  </td>
                  <td className="money-cell">
                    {formatMoney(row.priceMinor, row.currency, locale)}
                  </td>
                  <td className="money-cell">
                    {formatMoney(row.paidMinor, row.currency, locale)}
                  </td>
                  <td className="billing-balance money-cell">
                    {formatMoney(row.balanceMinor, row.currency, locale)}
                  </td>
                  <td>
                    {row.nextPaymentDue ? formatDate(row.nextPaymentDue) : "—"}{" "}
                    {row.overdue && (
                      <span className="badge warn">{t("Overdue")}</span>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={6}>
                    {loading
                      ? t("Loading…")
                      : error
                        ? "—"
                        : t("No outstanding balances.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && rows.length > 0 && <p className="hint">{t("Loading…")}</p>}
        {cursor && (
          <div className="row">
            <button disabled={loading} onClick={() => void load(cursor)}>
              {t("Load more")}
            </button>
          </div>
        )}
      </div>
      {userId && (
        <MemberDrawer
          key={userId}
          userId={userId}
          onClose={() => setUserId(null)}
          onChanged={changed}
        />
      )}
    </div>
  );
}
