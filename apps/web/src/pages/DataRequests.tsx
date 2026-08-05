import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeletionRequest, Page } from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import type { WebTranslationKey } from "../i18n/resources";

const statusMeta: Record<
  DeletionRequest["status"],
  { cls: string; label: WebTranslationKey }
> = {
  pending: { cls: "warn", label: "Pending" },
  approved: { cls: "ok", label: "Approved" },
  rejected: { cls: "danger", label: "Denied" },
};

export function DataRequests() {
  const { t, i18n } = useTranslation();
  const [requests, setRequests] = useState<DeletionRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Without `cursor`, load the first page (resetting the list); otherwise append the next page. */
  const load = useCallback(
    async (cursor: string | null, signal?: AbortSignal) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (status) params.set("status", status);
      try {
        const page = await api<Page<DeletionRequest>>(
          `/api/admin/deletion-requests?${params.toString()}`,
          { signal },
        );
        setRequests((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(errorMessage(err, t, "Could not load data."));
      } finally {
        setLoading(false);
      }
    },
    [status, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [load]);

  async function approve(r: DeletionRequest) {
    const who = r.name || r.email || t("This member's account");
    if (
      !confirm(
        t(
          "{{who}} and all related data will be permanently deleted. This action cannot be undone. Do you approve?",
          { who },
        ),
      )
    ) {
      return;
    }
    setBusyId(r.id);
    setError(null);
    try {
      await api(`/api/admin/deletion-requests/${r.id}/approve`, {
        method: "POST",
      });
      await load(null);
    } catch (err) {
      setError(errorMessage(err, t, "The operation failed."));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(r: DeletionRequest) {
    setBusyId(r.id);
    setError(null);
    try {
      await api(`/api/admin/deletion-requests/${r.id}/reject`, {
        method: "POST",
      });
      await load(null);
    } catch (err) {
      setError(errorMessage(err, t, "The operation failed."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="stagger">
      <h1>{t("Data deletion requests")}</h1>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="deletion-status">{t("Status")}</label>
          <select
            id="deletion-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t("All")}</option>
            {Object.entries(statusMeta).map(([value, meta]) => (
              <option key={value} value={value}>
                {t(meta.label)}
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
              <th>{t("Member")}</th>
              <th>{t("Email")}</th>
              <th>{t("Request date")}</th>
              <th>{t("Status")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td>{r.name || "—"}</td>
                <td>{r.email || "—"}</td>
                <td>
                  {new Date(r.requestedAt).toLocaleDateString(
                    dateLocale(i18n.resolvedLanguage),
                  )}
                </td>
                <td>
                  <span className={`badge ${statusMeta[r.status].cls}`}>
                    {t(statusMeta[r.status].label)}
                  </span>
                </td>
                <td>
                  {r.status === "pending" && (
                    <div className="row">
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={() => void approve(r)}
                      >
                        {t("Approve")}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busyId === r.id}
                        onClick={() => void reject(r)}
                      >
                        {t("Reject")}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {requests.length === 0 && !error && !loading && (
              <tr>
                <td colSpan={5}>{t("No requests.")}</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={5}>{t("Loading…")}</td>
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
