import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Page,
  RenewalDueMember,
  RenewalReminderResult,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";

const WINDOWS = [7, 14, 30, 90];

export function Renewals() {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  const [members, setMembers] = useState<RenewalDueMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [withinDays, setWithinDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendingFor, setSendingFor] = useState<string | null>(null);

  /**
   * Without `cursor`, the first page is loaded (resetting the list); with it, the
   * next page is appended. A window change invalidates the cursor, so loading restarts.
   *
   * The "Load more" request must also be cancelable: if a next-page response is
   * in flight when the window changes, it would be appended to the new list for
   * a different query, producing both duplicates and an incorrect cursor.
   */
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setLoading(true);
      const params = new URLSearchParams({ withinDays: String(withinDays) });
      if (cursor) params.set("cursor", cursor);
      try {
        const page = await api<Page<RenewalDueMember>>(
          `/api/admin/reports/renewals?${params.toString()}`,
          { signal: controller.signal },
        );
        setMembers((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(errorMessage(err, t, "Could not load data."));
      } finally {
        // A canceled request must not clear the replacement request's loading state.
        if (inFlight.current === controller) setLoading(false);
      }
    },
    [withinDays, t],
  );

  useEffect(() => {
    void load(null);
    return () => inFlight.current?.abort();
  }, [load]);

  async function remind(member: RenewalDueMember) {
    setSendingFor(member.userId);
    setNotice(null);
    try {
      const result = await api<RenewalReminderResult>(
        `/api/admin/reports/renewals/${member.userId}/remind`,
        { method: "POST" },
      );
      // Update the row in place: refetching the full list would discard the
      // additional pages loaded by the user.
      setMembers((prev) =>
        prev.map((row) =>
          row.userId === member.userId
            ? { ...row, lastReminderAt: result.sentAt }
            : row,
        ),
      );
      setNotice(t("Reminder sent."));
      setError(null);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(errorMessage(err, t, "Could not load data."));
    } finally {
      setSendingFor(null);
    }
  }

  return (
    <div className="stagger">
      <h1>{t("Renewals")}</h1>

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="renewal-window">{t("Days left")}</label>
          <select
            id="renewal-window"
            value={withinDays}
            onChange={(e) => setWithinDays(Number(e.target.value))}
          >
            {WINDOWS.map((days) => (
              <option key={days} value={days}>
                {t("Within {{days}} days", { days })}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="msg error">{error}</div>}
      {notice && <div className="msg">{notice}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("Full name")}</th>
              <th>{t("Phone")}</th>
              <th>{t("Email")}</th>
              <th>{t("Ends on")}</th>
              <th>{t("Days left")}</th>
              <th>{t("Last reminder")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td>
                  {member.firstName} {member.lastName}
                </td>
                <td>{member.phone}</td>
                <td>{member.email}</td>
                <td>{new Date(member.endsAt).toLocaleDateString(locale)}</td>
                <td>
                  {member.remainingDays === 0
                    ? t("Today")
                    : member.remainingDays}
                </td>
                <td>
                  {member.lastReminderAt
                    ? new Date(member.lastReminderAt).toLocaleString(locale)
                    : t("Never")}
                </td>
                <td>
                  <button
                    className="ghost"
                    onClick={() => void remind(member)}
                    disabled={sendingFor !== null}
                  >
                    {sendingFor === member.userId
                      ? t("Sending…")
                      : t("Send reminder")}
                  </button>
                </td>
              </tr>
            ))}
            {members.length === 0 && !error && !loading && (
              <tr>
                <td colSpan={7}>{t("No upcoming renewals.")}</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7}>{t("Loading…")}</td>
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
            {t("Load more")}
          </button>
        )}
      </div>
    </div>
  );
}
