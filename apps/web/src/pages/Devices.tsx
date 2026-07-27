import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import type {
  Device,
  DeviceCreated,
  DeviceDirection,
  GymSettings,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { usePollingQuery } from "../hooks/usePollingQuery";
import { errorMessage } from "../i18n/errors";
import { dateLocale } from "../i18n/format";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Yazdırma penceresine yazılan minimal sayfa: turnikeye yapıştırılacak QR + etiket
function printQr(
  name: string,
  title: string,
  direction: string,
  dataUrl: string,
): void {
  const win = window.open("", "_blank");
  if (!win) {
    return;
  }
  win.document.write(`<!doctype html>
    <html><head><title>${escapeHtml(title)}</title></head>
    <body style="text-align:center;font-family:sans-serif;padding:40px;">
      <h2>${escapeHtml(name)}</h2>
      <p>${escapeHtml(direction)}</p>
      <img src="${dataUrl}" style="width:320px;height:320px;" />
    </body></html>`);
  win.document.close();
  // Görsel yüklenmeden print açılırsa çıktı boş kalabilir
  const img = win.document.querySelector("img");
  const doPrint = () => {
    win.focus();
    win.print();
  };
  if (img && !img.complete) {
    img.onload = doPrint;
  } else {
    doPrint();
  }
}

export function Devices() {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale) : "—";
  const directionLabel = (value: DeviceDirection) =>
    value === "in" ? t("Giriş") : t("Turnike çıkışı");
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<DeviceDirection>("in");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<DeviceCreated | null>(null);
  const [createdQr, setCreatedQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [locationConfigured, setLocationConfigured] = useState(true);

  useEffect(() => {
    // Statik QR fiziksel varlık kanıtı taşımaz; konum doğrulaması kapalıysa
    // yönetici uyarılır (okunamazsa uyarı gösterilmez)
    api<GymSettings>("/api/admin/settings")
      .then((s) => setLocationConfigured(s.location !== null))
      .catch(() => undefined);
  }, []);

  async function load(signal?: AbortSignal) {
    try {
      setDevices(await api<Device[]>("/api/admin/devices", { signal }));
      setError(null);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(errorMessage(err, t, "Yüklenemedi."));
    }
  }

  usePollingQuery(load, 10000);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const device = await api<DeviceCreated>("/api/admin/devices", {
        method: "POST",
        body: { name, direction },
      });
      setCreated(device);
      setCreatedQr(
        await QRCode.toDataURL(device.qrContent, { width: 320, margin: 2 }),
      );
      setName("");
      setDirection("in");
      await load();
    } catch (err) {
      setError(errorMessage(err, t, "Cihaz eklenemedi."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(device: Device) {
    if (
      !confirm(
        t('"{{name}}" cihazını silmek istediğinize emin misiniz?', {
          name: device.name,
        }),
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api(`/api/admin/devices/${device.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(errorMessage(err, t, "Cihaz silinemedi."));
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
      setPreviewUrl(null);
      return;
    }
    const dataUrl = await QRCode.toDataURL(device.qrContent, {
      width: 320,
      margin: 2,
    });
    setPreviewId(device.id);
    setPreviewUrl(dataUrl);
  }

  return (
    <div className="stagger">
      <h1>{t("Cihazlar")}</h1>
      {!locationConfigured && (
        <div className="msg warn">
          {t(
            "Salon konumu yapılandırılmamış: statik turnike QR'ının fotoğrafı salon dışından da geçiş açabilir. Ayarlar sayfasından konum doğrulamasını etkinleştirin.",
          )}
        </div>
      )}
      {error && <div className="msg error">{error}</div>}
      {created && (
        <div className="panel">
          <h2>{t("Yeni cihaz — {{name}}", { name: created.name })}</h2>
          <p style={{ color: "var(--ink-dim)", marginBottom: 10 }}>
            {t(
              "Bu token yalnızca şimdi görüntülenir; cihazın yapılandırmasına kaydedin. Kaybederseniz cihazı silip yeniden eklemeniz gerekir.",
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
              {copied ? t("Kopyalandı") : t("Kopyala")}
            </button>
          </div>
          {createdQr && (
            <div style={{ marginTop: 16 }}>
              <p style={{ color: "var(--ink-dim)", marginBottom: 10 }}>
                {t(
                  "Bu statik QR'ı yazdırıp turnikeye yapıştırın — üyeler girişte bunu okutacak.",
                )}
              </p>
              <div className="qr-box">
                <img
                  src={createdQr}
                  alt={t("{{name}} QR kodu", { name: created.name })}
                />
              </div>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  printQr(
                    created.name,
                    t("{{name}} — Turnike QR", { name: created.name }),
                    directionLabel(created.direction),
                    createdQr,
                  )
                }
              >
                {t("QR'ı yazdır")}
              </button>
            </div>
          )}
        </div>
      )}
      {previewId && previewUrl && (
        <div className="panel">
          <h2>
            {t("{{name}} — QR", {
              name: devices.find((d) => d.id === previewId)?.name ?? t("Cihaz"),
            })}
          </h2>
          <div className="qr-box">
            <img src={previewUrl} alt={t("Cihaz QR kodu")} />
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
                    t("{{name}} — Turnike QR", { name: device.name }),
                    directionLabel(device.direction),
                    previewUrl,
                  );
                }
              }}
            >
              {t("Yazdır")}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setPreviewId(null);
                setPreviewUrl(null);
              }}
            >
              {t("Kapat")}
            </button>
          </div>
        </div>
      )}
      <div className="panel">
        <h2>{t("Cihaz ekle")}</h2>
        <form className="row" onSubmit={create}>
          <div className="field">
            <label htmlFor="deviceName">{t("Ad")}</label>
            <input
              id="deviceName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("Giriş turnikesi")}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="deviceDirection">{t("Yön")}</label>
            <select
              id="deviceDirection"
              value={direction}
              onChange={(e) => setDirection(e.target.value as DeviceDirection)}
            >
              <option value="in">{t("Giriş")}</option>
              <option value="out">{t("Turnike çıkışı")}</option>
            </select>
          </div>
          <button type="submit" disabled={busy}>
            {busy ? t("Ekleniyor…") : t("Cihaz ekle")}
          </button>
        </form>
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>{t("Ad")}</th>
              <th>{t("Yön")}</th>
              <th>{t("Durum")}</th>
              <th>{t("Son görülme")}</th>
              <th>{t("Eklenme")}</th>
              <th>{t("Uptime (24s)")}</th>
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
                    <span className="badge ok">{t("Çevrimiçi")}</span>
                  ) : (
                    <span className="badge danger">{t("Çevrimdışı")}</span>
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
                    {previewId === d.id ? t("QR'ı gizle") : t("QR göster")}
                  </button>{" "}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void remove(d)}
                  >
                    {t("Sil")}
                  </button>
                </td>
              </tr>
            ))}
            {devices.length === 0 && !error && (
              <tr>
                <td colSpan={7}>{t("Kayıtlı cihaz yok.")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
