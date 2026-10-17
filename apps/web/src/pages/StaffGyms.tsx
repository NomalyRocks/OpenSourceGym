import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import type { PublicUser, SetUserGymsRequest } from "@opengym/shared";
import { api } from "../lib/api";
import { useGyms } from "../lib/gyms";
import { errorMessage } from "../i18n/errors";

/** Owner-only: decide which gyms an admin/staff account is scoped to. */
export function StaffGyms() {
  const { t } = useTranslation();
  const { gyms } = useGyms();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  // Unsaved edits per user id
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const q = query.trim();
    if (q.length < 2) {
      setUsers(null);
      setMsg({
        kind: "error",
        text: t("Enter at least two characters to search."),
      });
      return;
    }
    try {
      const found = await api<PublicUser[]>(
        `/api/admin/users?q=${encodeURIComponent(q)}`,
      );
      setUsers(found.filter((u) => u.role === "admin" || u.role === "staff"));
      setDrafts({});
    } catch (err) {
      setUsers(null);
      setMsg({ kind: "error", text: errorMessage(err, t, "Search failed.") });
    }
  }

  const current = (u: PublicUser) => drafts[u.id] ?? u.gymIds;

  function toggle(u: PublicUser, gymId: string) {
    const ids = current(u);
    setDrafts({
      ...drafts,
      [u.id]: ids.includes(gymId)
        ? ids.filter((id) => id !== gymId)
        : [...ids, gymId],
    });
  }

  async function save(u: PublicUser) {
    setMsg(null);
    const body: SetUserGymsRequest = { gymIds: current(u) };
    try {
      await api(`/api/admin/users/${u.id}/gyms`, { method: "PUT", body });
      setUsers(
        (prev) =>
          prev?.map((x) =>
            x.id === u.id ? { ...x, gymIds: body.gymIds } : x,
          ) ?? null,
      );
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[u.id];
        return next;
      });
      setMsg({ kind: "success", text: t("Gym assignment saved.") });
    } catch (err) {
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Could not save changes."),
      });
    }
  }

  return (
    <div className="stagger">
      <PageHeader
        title={t("Staff assignment")}
        subtitle={t(
          "Choose which gyms each administrator or staff member can work in.",
        )}
      />
      <form className="panel" onSubmit={search}>
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        <p className="hint" style={{ marginBottom: 14 }}>
          {t(
            "Find an administrator or staff member, then choose the gyms they can work in.",
          )}
        </p>
        <div className="row">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search members…")}
            style={{ width: 260 }}
          />
          <button type="submit">{t("Search")}</button>
        </div>
      </form>
      {users && (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>{t("Full name")}</th>
                <th>{t("Role")}</th>
                <th>{t("Gyms")}</th>
                <th>{t("Action")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.firstName} {u.lastName}
                    <div className="hint">{u.email}</div>
                  </td>
                  <td>
                    <span className={`badge ${u.role}`}>
                      {u.role === "admin" ? t("Administrator") : t("Staff")}
                    </span>
                  </td>
                  <td>
                    <div className="row">
                      {gyms.map((g) => (
                        <label key={g.id} className="check">
                          <input
                            type="checkbox"
                            checked={current(u).includes(g.id)}
                            onChange={() => toggle(u, g.id)}
                          />{" "}
                          {g.name}
                          {!g.active && ` (${t("Inactive")})`}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={drafts[u.id] === undefined}
                      onClick={() => void save(u)}
                    >
                      {t("Save")}
                    </button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={4}>{t("No matching staff member found.")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
