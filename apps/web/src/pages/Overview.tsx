import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type {
  AdminStats,
  EntryEvent,
  OccupancyResponse,
  Page,
  PublicUser,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { usePollingQuery } from "../hooks/usePollingQuery";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";

// Payment/revenue tracking is out of scope (a PRD non-goal) — the card is blurred
// with a placeholder value only for visual consistency.
const MOCK_REVENUE = 4280;

function KpiCard({
  label,
  value,
  delta,
  color,
  blurred,
  to,
}: {
  label: string;
  value: string;
  delta?: string;
  color?: string;
  blurred?: boolean;
  /** When provided, the card becomes clickable and links to this page. */
  to?: string;
}) {
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div
        className={blurred ? "kpi-value kpi-blur" : "kpi-value"}
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {delta && <div className="kpi-delta">{delta}</div>}
    </>
  );

  // The number is not useful to staff unless it leads to an action:
  // "12 pending renewals" matters only if those 12 people can be reached.
  if (to) {
    return (
      <Link className="kpi-card kpi-card-link" to={to}>
        {body}
      </Link>
    );
  }
  return <div className="kpi-card">{body}</div>;
}

export function Overview() {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancyResponse | null>(null);
  const [entries, setEntries] = useState<EntryEvent[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchAbort = useRef<AbortController | null>(null);

  async function load(signal: AbortSignal) {
    try {
      const [s, occ, ev] = await Promise.all([
        api<AdminStats>("/api/admin/stats", { signal }),
        api<OccupancyResponse>("/api/me/occupancy", { signal }),
        // The overview shows only the latest few entries, so request fewer from the server.
        api<Page<EntryEvent>>("/api/admin/entry-events?limit=6", { signal }),
      ]);
      setStats(s);
      setOccupancy(occ);
      setEntries(ev.items);
      setError(null);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(errorMessage(err, t, "Could not load data."));
    }
  }

  usePollingQuery(load, 15000);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    // Cancel the previous search so a late stale response cannot overwrite the new result.
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    try {
      setResults(
        await api<PublicUser[]>(`/api/admin/users?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        }),
      );
    } catch (err) {
      if (isAbortError(err)) return;
      setResults(null);
      setError(errorMessage(err, t, "Search failed."));
    }
  }

  const occupancyValue =
    occupancy?.ratio != null
      ? `%${Math.round(occupancy.ratio * 100)}`
      : (occupancy?.inside.toString() ?? "—");
  const occupancyDelta =
    occupancy == null
      ? undefined
      : occupancy.capacity != null
        ? t("{{inside}}/{{capacity}} people inside", {
            inside: occupancy.inside,
            capacity: occupancy.capacity,
          })
        : t("{{inside}} people inside", { inside: occupancy.inside });

  return (
    <div className="stagger">
      <h1>{t("Overview")}</h1>
      {error && <div className="msg error">{error}</div>}

      <div className="kpi-grid">
        <KpiCard
          label={t("Today's revenue")}
          value={new Intl.NumberFormat(locale, {
            style: "currency",
            currency: "TRY",
            maximumFractionDigits: 0,
          }).format(MOCK_REVENUE)}
          delta={t("Payment tracking coming soon")}
          color="var(--ok)"
          blurred
        />
        <KpiCard
          label={t("Active members")}
          value={stats ? String(stats.activeMembers) : "—"}
          delta={t("active subscriptions")}
        />
        <KpiCard
          label={t("Gym occupancy")}
          value={occupancyValue}
          delta={occupancyDelta}
        />
        <KpiCard
          label={t("Renewals due")}
          value={stats ? String(stats.renewalsDue) : "—"}
          delta={t("within 7 days")}
          color="var(--warn)"
          to="/renewals"
        />
      </div>

      <div className="overview-grid">
        <div className="panel">
          <div
            className="row"
            style={{ justifyContent: "space-between", marginBottom: 18 }}
          >
            <h2 style={{ marginBottom: 0 }}>{t("Members")}</h2>
            <form onSubmit={search}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Search members…")}
                style={{ width: 220 }}
              />
            </form>
          </div>
          <table>
            <thead>
              <tr>
                <th>{t("Full name")}</th>
                <th>{t("Phone")}</th>
                <th>{t("Email")}</th>
                <th>{t("Role")}</th>
              </tr>
            </thead>
            <tbody>
              {(results ?? []).map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.firstName} {u.lastName}
                  </td>
                  <td>{u.phone}</td>
                  <td>{u.email}</td>
                  <td>
                    <span className={`badge ${u.role}`}>
                      {t(
                        u.role === "admin"
                          ? "Administrator"
                          : u.role === "staff"
                            ? "Staff"
                            : "Member",
                      )}
                    </span>
                  </td>
                </tr>
              ))}
              {results !== null && results.length === 0 && (
                <tr>
                  <td colSpan={4}>{t("No matching member found.")}</td>
                </tr>
              )}
              {results === null && (
                <tr>
                  <td colSpan={4}>
                    {t("Enter at least two characters to search.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h2>{t("Recent entries")}</h2>
          <div className="list">
            {entries.map((e) => (
              <div className="list-row" key={e.id}>
                <div className="list-row-main">
                  <div className="list-row-title">
                    {e.memberName ?? e.deviceName}
                  </div>
                  <div className="list-row-sub">{e.deviceName}</div>
                </div>
                <div className="list-row-side">
                  <div>
                    {new Date(e.at).toLocaleTimeString(locale, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                  <div
                    className={e.allowed ? "list-row-ok" : "list-row-danger"}
                  >
                    {e.allowed ? t("Allowed") : t("Denied")}
                  </div>
                </div>
              </div>
            ))}
            {entries.length === 0 && <p className="hint">{t("No records.")}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
