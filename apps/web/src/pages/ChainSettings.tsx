import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ChainSettings as ChainSettingsData,
  LegalConfig,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { useProfile } from "../lib/profile";

/** Chain-wide settings: chain name and legal documents. Only the owner may save. */
export function ChainSettings() {
  const { t } = useTranslation();
  const { profile } = useProfile();
  const canEdit = profile?.role === "owner";
  const [settings, setSettings] = useState<ChainSettingsData | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api<ChainSettingsData>("/api/admin/settings", { signal: controller.signal })
      .then(setSettings)
      .catch((err) => {
        if (isAbortError(err)) return;
        setMsg({
          kind: "error",
          text: errorMessage(err, t, "Could not load data."),
        });
      });
    return () => controller.abort();
  }, [t]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/admin/settings", { method: "PUT", body: settings });
      setMsg({ kind: "success", text: t("Settings saved.") });
    } catch (err) {
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Could not save changes."),
      });
    } finally {
      setBusy(false);
    }
  }

  const legal: LegalConfig = settings?.legal ?? {
    dataProcessingUrl: null,
    privacyUrl: null,
    version: 1,
  };
  const setLegal = (next: LegalConfig) =>
    settings && setSettings({ ...settings, legal: next });

  return (
    <div className="stagger">
      <h1>{t("Chain settings")}</h1>
      <form className="panel" onSubmit={save} style={{ maxWidth: 560 }}>
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0 }}>
          <div className="field">
            <label htmlFor="chainName">{t("Chain name")}</label>
            <input
              id="chainName"
              value={settings?.chainName ?? ""}
              onChange={(e) =>
                settings &&
                setSettings({ ...settings, chainName: e.target.value })
              }
              required
            />
          </div>
          <h2 style={{ marginTop: 28 }}>{t("Legal documents")}</h2>
          <p className="hint" style={{ marginBottom: 14 }}>
            {t(
              "OpenGym does not provide these texts; the operator defines the address of the documents it publishes under its own regulations (e.g. GDPR, CCPA). If left blank, the consent checkbox on the mobile signup screen is shown without a link.",
            )}
          </p>
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="field">
              <label htmlFor="dataProcessingUrl">
                {t("Data processing notice URL")}
              </label>
              <input
                id="dataProcessingUrl"
                value={legal.dataProcessingUrl ?? ""}
                onChange={(e) =>
                  setLegal({ ...legal, dataProcessingUrl: e.target.value })
                }
                placeholder="https://…"
              />
            </div>
            <div className="field">
              <label htmlFor="privacyUrl">{t("Privacy policy URL")}</label>
              <input
                id="privacyUrl"
                value={legal.privacyUrl ?? ""}
                onChange={(e) =>
                  setLegal({ ...legal, privacyUrl: e.target.value })
                }
                placeholder="https://…"
              />
            </div>
            <div className="field" style={{ maxWidth: 160 }}>
              <label htmlFor="legalVersion">{t("Document version")}</label>
              <input
                id="legalVersion"
                type="number"
                min={1}
                value={legal.version}
                onChange={(e) =>
                  setLegal({ ...legal, version: Number(e.target.value) })
                }
                required
              />
            </div>
          </div>

          {canEdit && (
            <button type="submit" disabled={busy || !settings}>
              {busy ? t("Saving…") : t("Save")}
            </button>
          )}
        </fieldset>
      </form>
    </div>
  );
}
