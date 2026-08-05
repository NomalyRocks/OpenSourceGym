import { useCallback, useEffect, useState } from "react";
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

  /**
   * Without `cursor`, the first page is loaded (resetting the list); with it, the
   * next page is appended. A filter change invalidates the cursor, so loading restarts.
   */
  const load = useCallback(
    async (cursor: string | null, signal?: AbortSignal) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (action) params.set("action", action);
      try {
        const page = await api<Page<AuditLogEntry>>(
          `/api/admin/audit?${params.toString()}`,
          { signal },
        );
        setEntries((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(errorMessage(err, t, "Could not load data."));
      } finally {
        setLoading(false);
      }
    },
    [action, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

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
