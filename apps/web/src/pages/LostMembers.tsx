import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  InactiveMemberRow,
  LapsedMemberRow,
  LostMembersPage,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { useGymApi } from "../lib/gyms";
import { useProfile } from "../lib/profile";
import { errorMessage } from "../i18n/errors";
import { PageHeader } from "../components/PageHeader";
import { MemberDrawer } from "../components/MemberDrawer";
import { useDateFormatter } from "../components/Modal";

type View = "inactive" | "lapsed";
type Row = InactiveMemberRow | LapsedMemberRow;

function lapsedRange() {
  const to = new Date();
  return {
    from: new Date(to.getTime() - 30 * 86_400_000).toISOString(),
    to: to.toISOString(),
  };
}

export function LostMembers() {
  const { t } = useTranslation();
  const gymApi = useGymApi();
  const { profile } = useProfile();
  const formatDate = useDateFormatter();
  const canExport = profile?.role === "owner" || profile?.role === "admin";
  const [view, setView] = useState<View>("inactive");
  const [days, setDays] = useState(14);
  const [daysInput, setDaysInput] = useState("14");
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  // Keep the range fixed while paging so the list and its export agree.
  const [range, setRange] = useState(lapsedRange);
  const query = useCallback(
    () =>
      new URLSearchParams(view === "inactive" ? { days: String(days) } : range),
    [view, days, range],
  );
  const load = useCallback(
    async (next: string | null = null) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setLoading(true);
      setError(null);
      if (!next) {
        setRows([]);
        setCursor(null);
        setTotal(0);
      }
      try {
        const params = query();
        params.set("limit", "50");
        if (next) params.set("cursor", next);
        const page = await api<LostMembersPage<Row>>(
          gymApi(`/reports/${view}-members?${params}`),
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setRows((prev) =>
          next
            ? [
                ...prev,
                ...page.items.filter(
                  (item) => !prev.some((row) => row.userId === item.userId),
                ),
              ]
            : page.items,
        );
        setTotal(page.total);
        setCursor(page.nextCursor);
      } catch (err) {
        if (!controller.signal.aborted && !isAbortError(err))
          setError(errorMessage(err, t, "Could not load data."));
      } finally {
        if (inFlight.current === controller) setLoading(false);
      }
    },
    [gymApi, query, view, t],
  );
  useEffect(() => {
    void load();
    return () => inFlight.current?.abort();
  }, [load]);
  const refresh = useCallback(() => {
    if (view === "lapsed") setRange(lapsedRange());
    else void load();
  }, [load, view]);
  const exportParams = query();
  exportParams.set("dataset", view);

  return (
    <div className="stagger">
      <PageHeader
        title={t("Lost members")}
        subtitle={t("Find members who stopped visiting or did not renew.")}
      />
      <div className="view-tabs" aria-label={t("Lost members")}>
        <button
          type="button"
          className={view === "inactive" ? "active" : ""}
          aria-pressed={view === "inactive"}
          onClick={() => setView("inactive")}
        >
          {t("Not visiting")}
        </button>
        <button
          type="button"
          className={view === "lapsed" ? "active" : ""}
          aria-pressed={view === "lapsed"}
          onClick={() => setView("lapsed")}
        >
          {t("Not renewed")}
        </button>
      </div>
      {error && (
        <div className="msg error">
          {error}
          <button className="ghost" onClick={() => void load()}>
            {t("Retry")}
          </button>
        </div>
      )}
      <div className="panel">
        {view === "inactive" ? (
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(daysInput);
              if (Number.isInteger(value) && value >= 1 && value <= 365)
                setDays(value);
            }}
          >
            <label htmlFor="inactive-days">{t("Days without a visit")}</label>
            <input
              id="inactive-days"
              type="number"
              min={1}
              max={365}
              step={1}
              required
              value={daysInput}
              onChange={(event) => setDaysInput(event.target.value)}
            />
            <button type="submit" className="ghost">
              {t("Apply")}
            </button>
            {[7, 14, 30, 60].map((preset) => (
              <button
                key={preset}
                type="button"
                className="ghost"
                aria-pressed={days === preset}
                onClick={() => {
                  setDaysInput(String(preset));
                  setDays(preset);
                }}
              >
                {preset} {t("days")}
              </button>
            ))}
          </form>
        ) : (
          <p className="hint">
            {t("Memberships ended in the last 30 days without renewal.")}
          </p>
        )}
        <div className="row">
          <span className="hint">
            {t("Members")}: {total}
          </span>
          <button className="ghost" disabled={loading} onClick={refresh}>
            {t("Refresh")}
          </button>
          {canExport && (
            <a
              className="button ghost"
              href={gymApi(`/reports/export?${exportParams}`)}
              download
            >
              {t("Download CSV")}
            </a>
          )}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("Member")}</th>
                <th>{t("Email")}</th>
                <th>{t("Phone")}</th>
                <th>{t("Last visit")}</th>
                {view === "inactive" && <th>{t("Days since last visit")}</th>}
                <th>
                  {view === "inactive"
                    ? t("Period ends")
                    : t("Membership ended")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  className="debtor-row"
                  key={row.userId}
                  onClick={() => setUserId(row.userId)}
                >
                  <td>
                    <button
                      className="ghost member-link"
                      onClick={(event) => {
                        event.stopPropagation();
                        setUserId(row.userId);
                      }}
                    >
                      {row.name || row.email}
                    </button>
                  </td>
                  <td>{row.email || "—"}</td>
                  <td>{row.phone || "—"}</td>
                  <td>
                    {row.lastEntryAt
                      ? formatDate(row.lastEntryAt)
                      : t("Never visited")}
                  </td>
                  {view === "inactive" && (
                    <td>
                      {"daysSinceLastEntry" in row
                        ? (row.daysSinceLastEntry ?? "—")
                        : "—"}
                    </td>
                  )}
                  <td>
                    {formatDate(
                      "periodEndsAt" in row ? row.periodEndsAt : row.endedAt,
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={view === "inactive" ? 6 : 5}>
                    {loading
                      ? t("Loading…")
                      : error
                        ? "—"
                        : t("No members match these filters.")}
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
          onChanged={refresh}
        />
      )}
    </div>
  );
}
