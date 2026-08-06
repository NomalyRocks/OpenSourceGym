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
import { dayEndIso, dayStartIso } from "../lib/dateRange";
import type { WebTranslationKey } from "../i18n/resources";

const reasonLabels: Record<GateRejectCode, WebTranslationKey> = {
  INVALID_QR: "Invalid code",
  UNKNOWN_DEVICE: "Unknown device",
  DEVICE_OFFLINE: "Turnstile offline",
  NO_ACTIVE_SUBSCRIPTION: "No active subscription",
  LOCATION_REQUIRED: "Location unavailable",
  OUT_OF_RANGE: "Outside gym location",
  MOCK_LOCATION: "Mock location",
  SHARING_BLOCKED: "Sharing block",
  ALREADY_INSIDE: "Already inside",
  GYM_LOCATION_UNSET: "Gym location not set",
};

// Fall back to raw text for records left by the old flow (INVALID_TOKEN/EXPIRED/REPLAY)
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
    // Resolve the bounds separately: the user can select only a start or only
    // an end. The end is pinned to the end of the day; sending the start of the
    // day would make the server's `$lte` exclude the selected final day entirely.
    const fromIso = dayStartIso(from);
    const toIso = dayEndIso(to);
    if (fromIso) params.set("from", fromIso);
    if (toIso) params.set("to", toIso);
    return params.toString();
  }

  // Automatic refresh updates only the first page. If the user has gone back
  // through history with "Load more," preserve the list and update only the
  // occupancy counter.
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
      setError(errorMessage(err, t, "Could not load data."));
    }
  }

  // A filter change invalidates the cursor, so the hook reloads the list from the start.
  usePollingQuery(refresh, 10000, `${allowed}|${from}|${to}`);

  /** Reset pagination on filter changes because the old cursor is invalid for the new filter. */
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
        setError(errorMessage(err, t, "Could not load data."));
      }
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="stagger">
      <h1>{t("Entries")}</h1>
      {occupancy && (
        <p className="hint" style={{ marginBottom: 16 }}>
          {t("Inside: {{count}}", { count: occupancy.inside })}
          {occupancy.ratio != null &&
            ` · ${t("Occupancy: {{percent}}%", {
              percent: Math.round(occupancy.ratio * 100),
            })}`}
        </p>
      )}
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="entries-result">{t("Result")}</label>
          <select
            id="entries-result"
            value={allowed}
            onChange={(e) => changeFilter(() => setAllowed(e.target.value))}
          >
            <option value="">{t("All")}</option>
            <option value="true">{t("Allowed")}</option>
            <option value="false">{t("Denied")}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="entries-from">{t("Start")}</label>
          <input
            id="entries-from"
            type="date"
            value={from}
            onChange={(e) => changeFilter(() => setFrom(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="entries-to">{t("End")}</label>
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
              <th>{t("Time")}</th>
              <th>{t("Device")}</th>
              <th>{t("Member")}</th>
              <th>{t("Result")}</th>
              <th>{t("Distance")}</th>
              <th>{t("Reason")}</th>
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
                    <span className="badge ok">{t("Allowed")}</span>
                  ) : (
                    <span className="badge danger">{t("Denied")}</span>
                  )}
                </td>
                {/* How far from the gym the scan came from — the only way to
                    review a disputed entry after the fact. */}
                <td>
                  {e.distanceM === null
                    ? "—"
                    : t("{{meters}} m", { meters: e.distanceM })}
                </td>
                <td>{reasonLabel(e.reason)}</td>
              </tr>
            ))}
            {entries.length === 0 && !error && (
              <tr>
                <td colSpan={6}>{t("No records.")}</td>
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
            {t("Load more")}
          </button>
        )}
      </div>
    </div>
  );
}
