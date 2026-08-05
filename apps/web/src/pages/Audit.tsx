import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuditLogEntry, Page } from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import type { WebTranslationKey } from "../i18n/resources";

const actionLabels: Partial<Record<string, WebTranslationKey>> = {
  "sharing-signal": "Sharing signal",
  "account-sharing-blocked": "Account sharing blocked",
  "profile-photo-updated": "Profile photo updated",
  "profile-photo-removed": "Profile photo removed",
  "account-deletion-requested": "Deletion request created",
  "account-deletion-cancelled": "Deletion request cancelled",
  "account-deletion-approved": "Deletion request approved",
  "account-deletion-rejected": "Deletion request rejected",
  // Backward compatibility: former names for "account-deletion-*" actions — old
  // audit records use these keys, and removing them would make past rows unreadable
  "kvkk-deletion-requested": "Deletion request created",
  "kvkk-deletion-cancelled": "Deletion request cancelled",
  "kvkk-deletion-approved": "Deletion request approved",
  "kvkk-deletion-rejected": "Deletion request rejected",
  "device-created": "Device created",
  "device-deleted": "Device deleted",
  "initial-password-changed": "Initial password changed",
  "role-assigned": "Role assigned",
  "subscription-created": "Subscription created",
  "settings-updated": "Settings updated",
  "renewal-reminder-sent": "Renewal reminder sent",
  "data-exported": "Data exported",
};

export function Audit() {
  const { t, i18n } = useTranslation();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A filter change starts a new generation. Anything still in flight from an
  // earlier one is ignored on arrival, so a slow first page cannot overwrite the
  // list the user is actually looking at.
  const generation = useRef(0);
  const loadMore = useRef<AbortController | null>(null);

  /**
   * Without `cursor`, the first page is loaded (resetting the list); with it, the
   * next page is appended. A filter change invalidates the cursor, so loading restarts.
   */
  const load = useCallback(
    async (
      cursor: string | null,
      signal: AbortSignal,
      forGeneration: number,
    ) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (action) params.set("action", action);
      try {
        const page = await api<Page<AuditLogEntry>>(
          `/api/admin/audit?${params.toString()}`,
          { signal },
        );
        if (forGeneration !== generation.current) return;
        setEntries((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (isAbortError(err) || forGeneration !== generation.current) return;
        setError(errorMessage(err, t, "Could not load data."));
      } finally {
        if (forGeneration === generation.current) setLoading(false);
      }
    },
    [action, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    // The previous filter's "load more" would append its rows to the new list.
    loadMore.current?.abort();
    loadMore.current = null;
    void load(null, controller.signal, current);
    return () => controller.abort();
  }, [load]);

  useEffect(() => () => loadMore.current?.abort(), []);

  function loadNextPage() {
    if (!nextCursor) return;
    loadMore.current?.abort();
    const controller = new AbortController();
    loadMore.current = controller;
    void load(nextCursor, controller.signal, generation.current);
  }

  return (
    <div className="stagger">
      <h1>{t("Audit log")}</h1>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="audit-action">{t("Action")}</label>
          <select
            id="audit-action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">{t("All")}</option>
            {Object.entries(actionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label ? t(label) : value}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="msg error">{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("Time")}</th>
              <th>{t("Actor")}</th>
              <th>{t("Action")}</th>
              <th>{t("Details")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const actionLabel = actionLabels[e.action];
              return (
                <tr key={e.id}>
                  <td>
                    {new Date(e.at).toLocaleString(
                      dateLocale(i18n.resolvedLanguage),
                    )}
                  </td>
                  <td>{e.actorEmail}</td>
                  <td>{actionLabel ? t(actionLabel) : e.action}</td>
                  <td>{e.details ? JSON.stringify(e.details) : "—"}</td>
                </tr>
              );
            })}
            {entries.length === 0 && !error && !loading && (
              <tr>
                <td colSpan={4}>{t("No records.")}</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={4}>{t("Loading…")}</td>
              </tr>
            )}
          </tbody>
        </table>
        {nextCursor && (
          <button
            onClick={loadNextPage}
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
