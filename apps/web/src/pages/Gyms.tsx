import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import { Link } from "react-router-dom";
import type { GymCreateInput, Gym, GymUpdateInput } from "@opengym/shared";
import { api } from "../lib/api";
import { useGyms } from "../lib/gyms";
import { errorMessage } from "../i18n/errors";

/** Owner-only: create, rename and (de)activate gyms. Gyms are never deleted. */
export function Gyms() {
  const { t } = useTranslation();
  const { gyms, refresh } = useGyms();
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);

  async function run(action: () => Promise<void>, fallback: "create" | "save") {
    setBusy(true);
    setMsg(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setMsg({
        kind: "error",
        text: errorMessage(
          err,
          t,
          fallback === "create"
            ? "Could not create the gym."
            : "Could not save changes.",
        ),
      });
    } finally {
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const body: GymCreateInput = { name: name.trim() };
    await run(async () => {
      await api<Gym>("/api/admin/gyms", { method: "POST", body });
      setName("");
      setMsg({ kind: "success", text: t("Gym created.") });
    }, "create");
  }

  async function rename(gym: Gym) {
    const body: GymUpdateInput = { name: editName.trim() };
    await run(async () => {
      await api<Gym>(`/api/admin/gyms/${gym.id}`, { method: "PUT", body });
      setEditingId(null);
    }, "save");
  }

  async function setActive(gym: Gym, active: boolean) {
    if (
      !active &&
      !confirm(
        t(
          'Deactivate "{{name}}"? Entry scans at this gym will be refused until it is activated again.',
          { name: gym.name },
        ),
      )
    ) {
      return;
    }
    const body: GymUpdateInput = { active };
    await run(async () => {
      await api<Gym>(`/api/admin/gyms/${gym.id}`, {
        method: "PUT",
        body,
      });
    }, "save");
  }

  return (
    <div className="stagger">
      <PageHeader
        title={t("Gyms")}
        subtitle={t("Create gyms, rename them or switch them off.")}
      />
      <form className="panel" onSubmit={create} style={{ maxWidth: 560 }}>
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        <div className="row">
          <div className="field">
            <label htmlFor="newGymName">{t("Gym name")}</label>
            <input
              id="newGymName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <button type="submit" disabled={busy || !name.trim()}>
            {t("Add gym")}
          </button>
        </div>
        <p className="hint">
          {t(
            "Set the location, capacity and devices from the gym's own pages after creating it.",
          )}
        </p>
      </form>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("Gym name")}</th>
              <th>{t("Status")}</th>
              <th>{t("Action")}</th>
            </tr>
          </thead>
          <tbody>
            {gyms.map((gym) => (
              <tr key={gym.id}>
                <td>
                  {editingId === gym.id ? (
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      aria-label={t("Gym name")}
                    />
                  ) : (
                    gym.name
                  )}
                </td>
                <td>
                  <span className={`badge ${gym.active ? "ok" : "warn"}`}>
                    {gym.active ? t("Active") : t("Inactive")}
                  </span>
                </td>
                <td>
                  <div className="row">
                    {editingId === gym.id ? (
                      <>
                        <button
                          type="button"
                          disabled={busy || !editName.trim()}
                          onClick={() => void rename(gym)}
                        >
                          {t("Save")}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          {t("Cancel")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => {
                            setEditingId(gym.id);
                            setEditName(gym.name);
                          }}
                        >
                          {t("Rename")}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => void setActive(gym, !gym.active)}
                        >
                          {gym.active ? t("Deactivate") : t("Activate")}
                        </button>
                        <Link
                          className="button ghost"
                          to={`/gyms/${gym.id}/settings`}
                        >
                          {t("Settings")}
                        </Link>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {gyms.length === 0 && (
              <tr>
                <td colSpan={3}>
                  {t("No gyms yet. Add the first one above.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
