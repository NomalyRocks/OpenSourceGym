import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/PageHeader";
import QRCode from "qrcode";
import type {
  Device,
  DeviceCreated,
  DeviceDirection,
  DeviceMode,
  Gym,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { usePollingQuery } from "../hooks/usePollingQuery";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";
import { useGymApi } from "../lib/gyms";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface QrImage {
  side: DeviceDirection;
  dataUrl: string;
}

async function deviceQrImages(
  device: Pick<Device, "direction" | "qrContent" | "exitQrContent">,
): Promise<QrImage[]> {
  const faces: { side: DeviceDirection; content: string }[] = [
    {
      side: device.direction === "out" ? "out" : "in",
      content: device.qrContent,
    },
  ];
  if (device.exitQrContent) {
    faces.push({ side: "out", content: device.exitQrContent });
  }
  return Promise.all(
    faces.map(async ({ side, content }) => ({
      side,
      dataUrl: await QRCode.toDataURL(content, { width: 320, margin: 2 }),
    })),
  );
}

// Print every face on one page, with labels for attaching each QR to the turnstile.
function printQr(
  name: string,
  title: string,
  faces: { label: string; dataUrl: string }[],
): void {
  const win = window.open("", "_blank");
  if (!win) {
    return;
  }
  win.document.write(`<!doctype html>
    <html><head><title>${escapeHtml(title)}</title>
      <style>
        @page { size: A4; margin: 12mm; }
        body { text-align: center; font-family: sans-serif; margin: 0; padding: 16px; }
        section { break-inside: avoid; margin: 16px 0; }
        p { margin: 0 0 8px; }
        img { width: 280px; height: 280px; }
      </style>
    </head><body>
      <h2>${escapeHtml(name)}</h2>
      ${faces
        .map(
          ({ label, dataUrl }) => `<section>
            <p>${escapeHtml(label)}</p>
            <img src="${dataUrl}" alt="${escapeHtml(label)}" />
          </section>`,
        )
        .join("")}
    </body></html>`);
  win.document.close();
  // Both faces must finish loading before the print dialog opens.
  void Promise.all(
    Array.from(win.document.images).map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) resolve();
          else img.onload = () => resolve();
        }),
    ),
  ).then(() => {
    win.focus();
    win.print();
  });
}

export function Devices() {
  const { t, i18n } = useTranslation();
  const gymApi = useGymApi();
  const locale = dateLocale(i18n.resolvedLanguage);
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale) : "—";
  const directionLabel = (value: DeviceMode) =>
    value === "both"
      ? t("Bidirectional")
      : value === "in"
        ? t("Entry")
        : t("Exit");
  const faceLabel = (mode: DeviceMode, side: DeviceDirection) =>
    mode === "both"
      ? side === "in"
        ? t("Entry side")
        : t("Exit side")
      : directionLabel(mode);
  const printableFaces = (mode: DeviceMode, images: QrImage[]) =>
    images.map(({ side, dataUrl }) => ({
      label: faceLabel(mode, side),
      dataUrl,
    }));
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<DeviceMode>("in");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<DeviceCreated | null>(null);
  const [createdQrs, setCreatedQrs] = useState<QrImage[]>([]);
  const [copied, setCopied] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewQrs, setPreviewQrs] = useState<QrImage[]>([]);
  const [locationConfigured, setLocationConfigured] = useState(true);

  useEffect(() => {
    // A static QR does not prove physical presence; warn the administrator when
    // location verification is disabled (show no warning if the setting cannot be read)
    api<Gym>(gymApi("/settings"))
      .then((s) => setLocationConfigured(s.location !== null))
      .catch(() => undefined);
  }, []);

  async function load(signal?: AbortSignal) {
    try {
      setDevices(await api<Device[]>(gymApi("/devices"), { signal }));
      setError(null);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(errorMessage(err, t, "Could not load data."));
    }
  }

  usePollingQuery(load, 10000);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const device = await api<DeviceCreated>(gymApi("/devices"), {
        method: "POST",
        body: { name, direction },
      });
      setCreated(device);
      setCreatedQrs([]);
      setCreatedQrs(await deviceQrImages(device));
      setName("");
      setDirection("in");
      await load();
    } catch (err) {
      setError(errorMessage(err, t, "Could not add the device."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(device: Device) {
    if (
      !confirm(
        t('Are you sure you want to delete the device "{{name}}"?', {
          name: device.name,
        }),
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api(gymApi(`/devices/${device.id}`), { method: "DELETE" });
      await load();
    } catch (err) {
      setError(errorMessage(err, t, "Could not delete the device."));
    }
  }

  async function copyToken() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function togglePreview(device: Device) {
    if (previewId === device.id) {
      setPreviewId(null);
      setPreviewQrs([]);
      return;
    }
    const images = await deviceQrImages(device);
    setPreviewId(device.id);
    setPreviewQrs(images);
  }

  return (
    <div className="stagger">
      <PageHeader
        title={t("Devices")}
        subtitle={t("Turnstile devices and their QR codes for this gym.")}
      />
      {!locationConfigured && (
        <div className="msg error">
          {t(
            "Gym location is not configured, so no turnstile will open. Location verification is mandatory: without it a photo of the static QR would open the gate from anywhere. Set the gym location on the Settings page.",
          )}
        </div>
      )}
      {error && <div className="msg error">{error}</div>}
      {created && (
        <div className="panel">
          <h2>{t("New device — {{name}}", { name: created.name })}</h2>
          <p style={{ color: "var(--ink-dim)", marginBottom: 10 }}>
            {t(
              "This token is shown only now; save it in the device configuration. If you lose it, delete and add the device again.",
            )}
          </p>
          <div className="row" style={{ alignItems: "center" }}>
            <code className="mono" style={{ wordBreak: "break-all" }}>
              {created.token}
            </code>
            <button
              type="button"
              className="ghost"
              onClick={() => void copyToken()}
            >
              {copied ? t("Copied") : t("Copy")}
            </button>
          </div>
          {createdQrs.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p style={{ color: "var(--ink-dim)", marginBottom: 10 }}>
                {t(
                  "Print this static QR code and attach it to the turnstile for members to scan.",
                )}
              </p>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {createdQrs.map(({ side, dataUrl }) => (
                  <div key={side}>
                    <p>{faceLabel(created.direction, side)}</p>
                    <div className="qr-box">
                      <img
                        src={dataUrl}
                        alt={faceLabel(created.direction, side)}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  printQr(
                    created.name,
                    t("{{name}} — Turnstile QR", { name: created.name }),
                    printableFaces(created.direction, createdQrs),
                  )
                }
              >
                {t("Print QR")}
              </button>
            </div>
          )}
        </div>
      )}
      {previewId && previewQrs.length > 0 && (
        <div className="panel">
          <h2>
            {t("{{name}} — QR", {
              name:
                devices.find((d) => d.id === previewId)?.name ?? t("Device"),
            })}
          </h2>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {previewQrs.map(({ side, dataUrl }) => (
              <div key={side}>
                <p>
                  {faceLabel(
                    devices.find((d) => d.id === previewId)?.direction ?? "in",
                    side,
                  )}
                </p>
                <div className="qr-box">
                  <img
                    src={dataUrl}
                    alt={faceLabel(
                      devices.find((d) => d.id === previewId)?.direction ??
                        "in",
                      side,
                    )}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="row">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                const device = devices.find((d) => d.id === previewId);
                if (device) {
                  printQr(
                    device.name,
                    t("{{name}} — Turnstile QR", { name: device.name }),
                    printableFaces(device.direction, previewQrs),
                  );
                }
              }}
            >
              {t("Print")}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setPreviewId(null);
                setPreviewQrs([]);
              }}
            >
              {t("Close")}
            </button>
          </div>
        </div>
      )}
      <div className="panel">
        <h2>{t("Add device")}</h2>
        <form className="row" onSubmit={create}>
          <div className="field">
            <label htmlFor="deviceName">{t("Name")}</label>
            <input
              id="deviceName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("Entry turnstile")}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="deviceDirection">{t("Direction")}</label>
            <select
              id="deviceDirection"
              value={direction}
              onChange={(e) => setDirection(e.target.value as DeviceMode)}
            >
              <option value="in">{t("Entry")}</option>
              <option value="out">{t("Exit")}</option>
              <option value="both">{t("Bidirectional")}</option>
            </select>
          </div>
          <button type="submit" disabled={busy}>
            {busy ? t("Adding…") : t("Add device")}
          </button>
        </form>
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("Name")}</th>
              <th>{t("Direction")}</th>
              <th>{t("Status")}</th>
              <th>{t("Last seen")}</th>
              <th>{t("Added")}</th>
              <th>{t("Uptime (24h)")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{directionLabel(d.direction)}</td>
                <td>
                  {d.online ? (
                    <span className="badge ok">{t("Online")}</span>
                  ) : (
                    <span className="badge danger">{t("Offline")}</span>
                  )}
                </td>
                <td>{fmt(d.lastSeenAt)}</td>
                <td>{fmt(d.createdAt)}</td>
                <td>{d.uptime24h.toFixed(1)}%</td>
                <td>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void togglePreview(d)}
                  >
                    {previewId === d.id ? t("Hide QR") : t("Show QR")}
                  </button>{" "}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void remove(d)}
                  >
                    {t("Delete")}
                  </button>
                </td>
              </tr>
            ))}
            {devices.length === 0 && !error && (
              <tr>
                <td colSpan={7}>{t("No registered devices.")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
