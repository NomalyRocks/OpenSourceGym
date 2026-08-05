import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  GymSettings,
  LegalConfig,
  ReminderConfig,
  SharingConfig,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";

const defaultSharing: SharingConfig = {
  memberMaxSessions: 2,
  staffMaxSessions: 5,
  signalThreshold: 3,
  signalWindowHours: 24,
  qrBlockHours: 24,
};

const defaultReminders: ReminderConfig = { enabled: false, daysBefore: [7, 1] };

const defaultLegal: LegalConfig = {
  dataProcessingUrl: null,
  privacyUrl: null,
  version: 1,
};

/**
 * Converts input such as "7, 1" into a threshold list. Invalid or empty input
 * must not erase existing thresholds; the server schema requires at least one.
 */
function parseDaysBefore(raw: string, fallback: number[]): number[] {
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 90);
  return parsed.length > 0 ? [...new Set(parsed)] : fallback;
}

export function Settings() {
  const { t } = useTranslation();
  const [gymName, setGymName] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radiusM, setRadiusM] = useState("");
  const [capacity, setCapacity] = useState("");
  const [autoExitHours, setAutoExitHours] = useState("");
  const [sharing, setSharing] = useState<SharingConfig>(defaultSharing);
  const [reminders, setReminders] = useState<ReminderConfig>(defaultReminders);
  const [legal, setLegal] = useState<LegalConfig>(defaultLegal);
  // Thresholds are edited as free text; intermediate states such as "7," cannot
  // be converted to a list while typing, so the raw text is kept separately.
  const [daysBeforeText, setDaysBeforeText] = useState(
    defaultReminders.daysBefore.join(", "),
  );
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Saving is disabled until the current settings load — otherwise an early save
  // would silently overwrite configured server values with form defaults
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    // The error path is essential: if loading fails, `loaded` remains false and
    // the Save button stays disabled — without seeing why, the user would think
    // the form was broken.
    void (async () => {
      try {
        const s = await api<GymSettings>("/api/admin/settings", {
          signal: controller.signal,
        });
        setGymName(s.gymName);
        if (s.location) {
          setLat(String(s.location.lat));
          setLng(String(s.location.lng));
          setRadiusM(String(s.location.radiusM));
        }
        if (s.capacity != null) setCapacity(String(s.capacity));
        setAutoExitHours(String(s.autoExitHours));
        setSharing(s.sharing);
        setReminders(s.reminders);
        setDaysBeforeText(s.reminders.daysBefore.join(", "));
        setLegal(s.legal);
        setLoaded(true);
      } catch (err) {
        if (isAbortError(err)) return;
        setMsg({
          kind: "error",
          text: errorMessage(err, t, "Could not load data."),
        });
      }
    })();
    return () => controller.abort();
  }, [t]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: {
          gymName,
          location:
            lat && lng && radiusM
              ? { lat: Number(lat), lng: Number(lng), radiusM: Number(radiusM) }
              : null,
          capacity: capacity ? Number(capacity) : null,
          autoExitHours: Number(autoExitHours),
          sharing,
          reminders: {
            enabled: reminders.enabled,
            // The fallback is NOT a fixed default; it is the current thresholds
            // from the server. An administrator who clears the field and saves
            // another setting must not silently change the gym's [30, 14] to [7, 1].
            daysBefore: parseDaysBefore(daysBeforeText, reminders.daysBefore),
          },
          legal,
        },
      });
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

  return (
    <div className="stagger">
      <h1>{t("Gym settings")}</h1>
      <form className="panel" onSubmit={save} style={{ maxWidth: 560 }}>
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        <div className="field">
          <label htmlFor="gymName">{t("Gym name")}</label>
          <input
            id="gymName"
            value={gymName}
            onChange={(e) => setGymName(e.target.value)}
            required
          />
        </div>
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="lat">{t("Latitude")}</label>
            <input
              id="lat"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="41.0082"
            />
          </div>
          <div className="field">
            <label htmlFor="lng">{t("Longitude")}</label>
            <input
              id="lng"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="28.9784"
            />
          </div>
          <div className="field">
            <label htmlFor="radiusM">{t("Radius (m)")}</label>
            <input
              id="radiusM"
              value={radiusM}
              onChange={(e) => setRadiusM(e.target.value)}
              placeholder="100"
            />
          </div>
        </div>
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field" style={{ maxWidth: 180 }}>
            <label htmlFor="capacity">{t("Capacity (people)")}</label>
            <input
              id="capacity"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="80"
            />
          </div>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="autoExitHours">
              {t("Automatic exit time (hours)")}
            </label>
            <input
              id="autoExitHours"
              type="number"
              min={1}
              value={autoExitHours}
              onChange={(e) => setAutoExitHours(e.target.value)}
              placeholder="12"
              required
            />
            <span className="hint">
              {t(
                "Without an exit turnstile, a member is no longer counted inside after this time.",
              )}
            </span>
          </div>
        </div>
        <h2>{t("Account sharing detection")}</h2>
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="memberMaxSessions">
              {t("Concurrent session limit per member")}
            </label>
            <input
              id="memberMaxSessions"
              type="number"
              min={1}
              max={10}
              value={sharing.memberMaxSessions}
              onChange={(e) =>
                setSharing({
                  ...sharing,
                  memberMaxSessions: Number(e.target.value),
                })
              }
              required
            />
            <span className="hint">
              {t(
                "When this limit is exceeded, the oldest session is closed automatically.",
              )}
            </span>
          </div>
          <div className="field">
            <label htmlFor="staffMaxSessions">
              {t("Concurrent session limit per staff/admin")}
            </label>
            <input
              id="staffMaxSessions"
              type="number"
              min={1}
              max={20}
              value={sharing.staffMaxSessions}
              onChange={(e) =>
                setSharing({
                  ...sharing,
                  staffMaxSessions: Number(e.target.value),
                })
              }
              required
            />
            <span className="hint">
              {t("Maximum concurrent sessions for staff and administrators.")}
            </span>
          </div>
          <div className="field">
            <label htmlFor="signalThreshold">
              {t("Signal threshold for automatic block")}
            </label>
            <input
              id="signalThreshold"
              type="number"
              min={1}
              max={20}
              value={sharing.signalThreshold}
              onChange={(e) =>
                setSharing({
                  ...sharing,
                  signalThreshold: Number(e.target.value),
                })
              }
              required
            />
            <span className="hint">
              {t(
                "The account is blocked automatically after this many suspicious signals.",
              )}
            </span>
          </div>
        </div>
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="signalWindowHours">
              {t("Signal window (hours)")}
            </label>
            <input
              id="signalWindowHours"
              type="number"
              min={1}
              max={168}
              value={sharing.signalWindowHours}
              onChange={(e) =>
                setSharing({
                  ...sharing,
                  signalWindowHours: Number(e.target.value),
                })
              }
              required
            />
            <span className="hint">
              {t("Time range in which signals are counted.")}
            </span>
          </div>
          <div className="field">
            <label htmlFor="qrBlockHours">
              {t("QR block duration (hours)")}
            </label>
            <input
              id="qrBlockHours"
              type="number"
              min={1}
              max={168}
              value={sharing.qrBlockHours}
              onChange={(e) =>
                setSharing({
                  ...sharing,
                  qrBlockHours: Number(e.target.value),
                })
              }
              required
            />
            <span className="hint">
              {t("How long the automatic block remains active.")}
            </span>
          </div>
        </div>

        <h2 style={{ marginTop: 28 }}>{t("Renewal reminders")}</h2>
        <p className="hint" style={{ marginBottom: 14 }}>
          {t(
            "Reminders are sent over SMTP; make sure SMTP is configured before enabling them.",
          )}
        </p>
        <div className="field">
          <label htmlFor="remindersEnabled">
            {t("Send automatic reminder e-mails")}
          </label>
          <input
            id="remindersEnabled"
            type="checkbox"
            style={{ width: 18, height: 18 }}
            checked={reminders.enabled}
            onChange={(e) =>
              setReminders({ ...reminders, enabled: e.target.checked })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="daysBefore">
            {t("Days before expiry (comma separated)")}
          </label>
          <input
            id="daysBefore"
            value={daysBeforeText}
            onChange={(e) => setDaysBeforeText(e.target.value)}
            placeholder="7, 1"
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

        <button type="submit" disabled={busy || !loaded}>
          {busy ? t("Saving…") : t("Save")}
        </button>
      </form>
    </div>
  );
}
