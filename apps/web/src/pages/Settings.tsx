import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  GymSettings,
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

/**
 * "7, 1" gibi bir girdiyi eşik listesine çevirir. Geçersiz veya boş girdi
 * mevcut eşikleri silmemeli; sunucu şeması en az bir eşik ister.
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
  // Eşikler serbest metin olarak düzenlenir; yazarken "7," gibi ara durumlar
  // listeye çevrilemediği için ham metin ayrı tutulur.
  const [daysBeforeText, setDaysBeforeText] = useState(
    defaultReminders.daysBefore.join(", "),
  );
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Mevcut ayarlar yüklenmeden kaydetmeye izin verilmez — aksi halde erken
  // bir kayıt, sunucudaki yapılandırılmış değerleri form varsayılanlarıyla
  // sessizce ezer
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    // Hata yolu şart: yükleme başarısız olursa `loaded` false kalır ve Kaydet
    // düğmesi kalıcı olarak devre dışı kalırdı — kullanıcı nedenini
    // göremeden formun çalışmadığını sanardı.
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
        setLoaded(true);
      } catch (err) {
        if (isAbortError(err)) return;
        setMsg({ kind: "error", text: errorMessage(err, t, "Yüklenemedi.") });
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
            // Geri düşüş sabit varsayılan DEĞİL, sunucudan gelen mevcut
            // eşiklerdir: alanı temizleyip başka bir ayarı kaydeden yönetici,
            // salonun [30, 14] eşiklerini sessizce [7, 1] yapmamalı.
            daysBefore: parseDaysBefore(daysBeforeText, reminders.daysBefore),
          },
        },
      });
      setMsg({ kind: "success", text: t("Ayarlar kaydedildi.") });
    } catch (err) {
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Kaydedilemedi."),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stagger">
      <h1>{t("Salon ayarları")}</h1>
      <form className="panel" onSubmit={save} style={{ maxWidth: 560 }}>
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        <div className="field">
          <label htmlFor="gymName">{t("Salon adı")}</label>
          <input
            id="gymName"
            value={gymName}
            onChange={(e) => setGymName(e.target.value)}
            required
          />
        </div>
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="lat">{t("Enlem")}</label>
            <input
              id="lat"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="41.0082"
            />
          </div>
          <div className="field">
            <label htmlFor="lng">{t("Boylam")}</label>
            <input
              id="lng"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="28.9784"
            />
          </div>
          <div className="field">
            <label htmlFor="radiusM">{t("Yarıçap (m)")}</label>
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
            <label htmlFor="capacity">{t("Kapasite (kişi)")}</label>
            <input
              id="capacity"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="80"
            />
          </div>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="autoExitHours">
              {t("Otomatik çıkış süresi (saat)")}
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
              {t("Çıkış turnikesi yoksa üye bu süre sonunda içeride sayılmaz.")}
            </span>
          </div>
        </div>
        <h2>{t("Hesap paylaşımı tespiti")}</h2>
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="memberMaxSessions">
              {t("Üye başına eşzamanlı oturum sınırı")}
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
              {t("Bu sınır aşıldığında en eski oturum otomatik kapatılır.")}
            </span>
          </div>
          <div className="field">
            <label htmlFor="staffMaxSessions">
              {t("Personel/admin başına eşzamanlı oturum sınırı")}
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
              {t("Personel ve adminler için eşzamanlı oturum üst sınırı.")}
            </span>
          </div>
          <div className="field">
            <label htmlFor="signalThreshold">
              {t("Otomatik engel için sinyal eşiği")}
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
                "Bu sayıda şüpheli sinyal birikince hesap otomatik engellenir.",
              )}
            </span>
          </div>
        </div>
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="signalWindowHours">
              {t("Sinyal penceresi (saat)")}
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
              {t("Sinyallerin sayıldığı zaman aralığı.")}
            </span>
          </div>
          <div className="field">
            <label htmlFor="qrBlockHours">{t("QR engeli süresi (saat)")}</label>
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
              {t("Otomatik engelin ne kadar süreceği.")}
            </span>
          </div>
        </div>

        <h2 style={{ marginTop: 28 }}>{t("Yenileme Hatırlatmaları")}</h2>
        <p className="hint" style={{ marginBottom: 14 }}>
          {t(
            "Hatırlatmalar SMTP üzerinden gönderilir; açmadan önce SMTP ayarlarının yapılandırıldığından emin olun.",
          )}
        </p>
        <div className="field">
          <label htmlFor="remindersEnabled">
            {t("Otomatik hatırlatma e-postalarını gönder")}
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
            {t("Kaç gün kala (virgülle ayırın)")}
          </label>
          <input
            id="daysBefore"
            value={daysBeforeText}
            onChange={(e) => setDaysBeforeText(e.target.value)}
            placeholder="7, 1"
          />
        </div>

        <button type="submit" disabled={busy || !loaded}>
          {busy ? t("Kaydediliyor…") : t("Kaydet")}
        </button>
      </form>
    </div>
  );
}
