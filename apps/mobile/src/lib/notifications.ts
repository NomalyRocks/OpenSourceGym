import { useCallback, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import type { MyDeletionRequest, MySubscription } from "@opengym/shared";
import { api } from "./api";
import type { MobileTranslationKey } from "../i18n/resources";

const READ_STORAGE_KEY = "opengym.notifications.read";
const PREFS_STORAGE_KEY = "opengym.notifications.prefs";

export type NotificationTone = "info" | "success" | "warning" | "error";

/**
 * Notification descriptor.
 *
 * Text is translated on the screen rather than here: the keys are already
 * English sentences, keeping the i18n layer in one place.
 */
export interface NotificationDescriptor {
  id: string;
  tone: NotificationTone;
  /** ISO date—for sorting and relative time. */
  at: string;
  titleKey: MobileTranslationKey;
  bodyKey: MobileTranslationKey;
  params?: Record<string, string | number>;
  read: boolean;
}

/**
 * Server-side notification feed.
 *
 * The API has no endpoint that returns member notifications. When added, this
 * is the only place that needs to change: call `GET /api/me/notifications`,
 * produce `NotificationDescriptor[]`, and return `connected: true`. The rest
 * of the screen remains unchanged.
 */
export async function fetchServerNotifications(): Promise<{
  items: Omit<NotificationDescriptor, "read">[];
  connected: boolean;
}> {
  return { items: [], connected: false };
}

const EXPIRY_WARNING_DAYS = 7;

/**
 * Local alerts derived from real subscription and deletion-request data.
 *
 * This is not fabricated content: every alert restates fields from the API.
 * When the server feed is connected, this generator can remain as-is or be removed.
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
        titleKey: "Your membership is not active",
        bodyKey: "Renew your membership at reception to enter the gym.",
      });
    } else if (remaining <= EXPIRY_WARNING_DAYS) {
      items.push({
        // The end date is part of the ID, so a renewed alert is unread again.
        id: `local:membership-expiring:${subscription.endsAt ?? ""}`,
        tone: "warning",
        at: now,
        titleKey: "Your membership expires soon",
        bodyKey: "{{n}} days left until your membership expires.",
        params: { n: remaining },
      });
    }
  }

  if (deletion?.status === "pending") {
    items.push({
      id: "local:deletion-pending",
      tone: "warning",
      at: deletion.requestedAt ?? now,
      titleKey: "Your account deletion request is under review",
      bodyKey:
        "Your request was sent to gym staff. Your account stays active until it is approved.",
    });
  } else if (deletion?.status === "rejected") {
    items.push({
      id: "local:deletion-rejected",
      tone: "info",
      at: deletion.requestedAt ?? now,
      titleKey: "Your account deletion request was rejected",
      bodyKey: "Contact gym reception for details.",
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
    // Store only the latest 100 IDs; the read list must not grow without limit.
    const trimmed = Array.from(ids).slice(-100);
    await SecureStore.setItemAsync(READ_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // If the write fails, read state applies only to this session.
  }
}

/**
 * Alert types the user wants to see. There is no push infrastructure; these
 * preferences actually filter the in-app list and badge.
 */
export interface NotificationPrefs {
  /** Membership expiry and inactive-membership alerts. */
  membership: boolean;
  /** Account-deletion request status changes. */
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
  /** Translation key displayed by the screen using `t()`. */
  error: MobileTranslationKey | null;
  /** Whether the server feed is connected—distinguishes an empty list from an unconnected layer. */
  serverConnected: boolean;
  refresh: () => Promise<void>;
  markAllRead: () => void;
  prefs: NotificationPrefs;
  setPref: (key: keyof NotificationPrefs, value: boolean) => void;
}

/**
 * Notification center. App creates it once and supplies the Home badge count
 * and Notifications list from the same source.
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

    // If the subscription cannot be read, do not silently empty the list; show why.
    setError(
      subscriptionResult.status === "rejected"
        ? "Could not load notifications."
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
