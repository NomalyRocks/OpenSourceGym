import { useCallback, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import type { MyDeletionRequest, MySubscription } from "@opengym/shared";
import { api } from "./api";
import type { MobileTranslationKey } from "../i18n/resources";

const READ_STORAGE_KEY = "opengym.notifications.read";
const PREFS_STORAGE_KEY = "opengym.notifications.prefs";

export type NotificationTone = "info" | "success" | "warning" | "error";

/**
 * Bildirim tanımı.
 *
 * Metinler burada değil ekranda çevrilir: anahtarlar zaten Türkçe cümleler ve
 * i18n katmanı tek yerde kalsın.
 */
export interface NotificationDescriptor {
  id: string;
  tone: NotificationTone;
  /** ISO tarih — sıralama ve göreli zaman için. */
  at: string;
  titleKey: MobileTranslationKey;
  bodyKey: MobileTranslationKey;
  params?: Record<string, string | number>;
  read: boolean;
}

/**
 * Sunucu tarafı bildirim akışı.
 *
 * API'de üyeye bildirim döndüren bir uç nokta yok. Eklendiğinde değişmesi
 * gereken tek yer burası: `GET /api/me/notifications` çağırıp
 * `NotificationDescriptor[]` üret, `connected: true` döndür. Ekranın geri
 * kalanı aynı kalır.
 */
export async function fetchServerNotifications(): Promise<{
  items: Omit<NotificationDescriptor, "read">[];
  connected: boolean;
}> {
  return { items: [], connected: false };
}

const EXPIRY_WARNING_DAYS = 7;

/**
 * Gerçek abonelik ve silme talebi verisinden türetilen yerel uyarılar.
 *
 * Uydurma içerik değil: hepsi API'den gelen alanların yeniden ifadesi. Sunucu
 * akışı bağlandığında bu üretici olduğu gibi kalabilir ya da kaldırılabilir.
 */
export function deriveLocalNotifications({
  subscription,
  deletion,
}: {
  subscription: MySubscription | null;
  deletion: MyDeletionRequest | null;
}): Omit<NotificationDescriptor, "read">[] {
  const items: Omit<NotificationDescriptor, "read">[] = [];
  const now = new Date().toISOString();

  if (subscription) {
    const remaining = subscription.remainingDays ?? 0;
    if (!subscription.active) {
      items.push({
        id: "local:membership-inactive",
        tone: "error",
        at: subscription.endsAt ?? now,
        titleKey: "Üyeliğin aktif değil",
        bodyKey:
          "Salona giriş yapabilmek için resepsiyondan üyeliğini yenilemen gerekiyor.",
      });
    } else if (remaining <= EXPIRY_WARNING_DAYS) {
      items.push({
        // Bitiş tarihi kimliğin parçası: yenileme sonrası uyarı yeniden okunmamış sayılır.
        id: `local:membership-expiring:${subscription.endsAt ?? ""}`,
        tone: "warning",
        at: now,
        titleKey: "Üyeliğin yakında bitiyor",
        bodyKey: "Üyeliğinin bitmesine {{n}} gün kaldı.",
        params: { n: remaining },
      });
    }
  }

  if (deletion?.status === "pending") {
    items.push({
      id: "local:deletion-pending",
      tone: "warning",
      at: deletion.requestedAt ?? now,
      titleKey: "Hesap silme talebin inceleniyor",
      bodyKey:
        "Talebin salon personeline iletildi. Onaylanana kadar hesabın açık kalır.",
    });
  } else if (deletion?.status === "rejected") {
    items.push({
      id: "local:deletion-rejected",
      tone: "info",
      at: deletion.requestedAt ?? now,
      titleKey: "Hesap silme talebin reddedildi",
      bodyKey: "Ayrıntı için salon resepsiyonuna başvurabilirsin.",
    });
  }

  return items;
}

async function readStoredIds(): Promise<Set<string>> {
  try {
    const raw = await SecureStore.getItemAsync(READ_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(
          parsed.filter((value): value is string => typeof value === "string"),
        )
      : new Set();
  } catch {
    return new Set();
  }
}

async function writeStoredIds(ids: Set<string>): Promise<void> {
  try {
    // Yalnızca son 100 kimlik saklanır; okundu listesi sınırsız büyümemeli.
    const trimmed = Array.from(ids).slice(-100);
    await SecureStore.setItemAsync(READ_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Yazma başarısız olursa okundu durumu yalnızca bu oturumda geçerli olur.
  }
}

/**
 * Kullanıcının hangi uyarı türlerini görmek istediği. Push altyapısı yok;
 * bu tercihler uygulama içi listeyi ve rozeti gerçekten filtreler.
 */
export interface NotificationPrefs {
  /** Üyelik bitişi ve pasif üyelik uyarıları. */
  membership: boolean;
  /** Hesap silme talebi durum değişiklikleri. */
  account: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = { membership: true, account: true };

function categoryOf(id: string): keyof NotificationPrefs | null {
  if (id.startsWith("local:membership")) return "membership";
  if (id.startsWith("local:deletion")) return "account";
  return null;
}

async function readStoredPrefs(): Promise<NotificationPrefs> {
  try {
    const raw = await SecureStore.getItemAsync(PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    const record = parsed as Partial<Record<keyof NotificationPrefs, unknown>>;
    return {
      membership:
        typeof record.membership === "boolean"
          ? record.membership
          : DEFAULT_PREFS.membership,
      account:
        typeof record.account === "boolean"
          ? record.account
          : DEFAULT_PREFS.account,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export interface NotificationCenter {
  items: NotificationDescriptor[];
  unreadCount: number;
  loading: boolean;
  /** Çeviri anahtarı; ekran `t()` ile gösterir. */
  error: MobileTranslationKey | null;
  /** Sunucu akışı bağlı mı — boş liste ile bağlanmamış katmanı ayırt eder. */
  serverConnected: boolean;
  refresh: () => Promise<void>;
  markAllRead: () => void;
  prefs: NotificationPrefs;
  setPref: (key: keyof NotificationPrefs, value: boolean) => void;
}

/**
 * Bildirim merkezi. App bir kez kurar; rozet sayısını Ana Sayfa'ya, listeyi
 * Bildirimler ekranına aynı kaynaktan verir.
 */
export function useNotificationCenter(enabled: boolean): NotificationCenter {
  const [descriptors, setDescriptors] = useState<
    Omit<NotificationDescriptor, "read">[]
  >([]);
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<MobileTranslationKey | null>(null);
  const [serverConnected, setServerConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void Promise.all([readStoredIds(), readStoredPrefs()]).then(
      ([ids, storedPrefs]) => {
        if (cancelled) return;
        setReadIds(ids);
        setPrefs(storedPrefs);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const setPref = useCallback(
    (key: keyof NotificationPrefs, value: boolean) => {
      setPrefs((current) => {
        const next = { ...current, [key]: value };
        void SecureStore.setItemAsync(
          PREFS_STORAGE_KEY,
          JSON.stringify(next),
        ).catch(() => undefined);
        return next;
      });
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    const [subscriptionResult, deletionResult, serverResult] =
      await Promise.allSettled([
        api<MySubscription>("/api/me/subscription"),
        api<MyDeletionRequest>("/api/me/deletion-request"),
        fetchServerNotifications(),
      ]);

    const subscription =
      subscriptionResult.status === "fulfilled"
        ? subscriptionResult.value
        : null;
    const deletion =
      deletionResult.status === "fulfilled" ? deletionResult.value : null;
    const server =
      serverResult.status === "fulfilled"
        ? serverResult.value
        : { items: [], connected: false };

    // Abonelik okunamadıysa liste sessizce boşalmasın; kullanıcı nedenini görsün.
    setError(
      subscriptionResult.status === "rejected"
        ? "Bildirimler alınamadı."
        : null,
    );
    setServerConnected(server.connected);
    setDescriptors(
      [
        ...server.items,
        ...deriveLocalNotifications({ subscription, deletion }),
      ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
    );
    setLoading(false);
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const items = useMemo(
    () =>
      descriptors
        .filter((descriptor) => {
          const category = categoryOf(descriptor.id);
          return category == null || prefs[category];
        })
        .map((descriptor) => ({
          ...descriptor,
          read: readIds.has(descriptor.id),
        })),
    [descriptors, prefs, readIds],
  );

  const markAllRead = useCallback(() => {
    setReadIds((current) => {
      const next = new Set(current);
      for (const item of items) next.add(item.id);
      void writeStoredIds(next);
      return next;
    });
  }, [items]);

  return {
    items,
    unreadCount: items.filter((item) => !item.read).length,
    loading,
    error,
    serverConnected,
    refresh,
    markAllRead,
    prefs,
    setPref,
  };
}
