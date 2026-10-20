import { useTranslation } from "react-i18next";
import { dateLocale } from "../i18n/format";
import { useNow } from "../hooks/useNow";

/**
 * Whole minutes between `enteredAt` and `now` (never negative, so a small
 * clock skew between server and browser cannot show "-1 min").
 */
export function minutesSince(enteredAt: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 60000));
}

/**
 * Formatters for "inside a gym" labels. Re-renders the caller every 30 s so
 * the durations stay current between data refreshes.
 */
export function usePresenceFormat() {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  const now = useNow();

  /** "12 min", "1 h", "1 h 25 min" */
  function duration(enteredAt: string): string {
    const total = minutesSince(enteredAt, now);
    if (total < 60) return t("{{n}} min", { n: total });
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m === 0 ? t("{{h}} h", { h }) : t("{{h}} h {{m}} min", { h, m });
  }

  /** Local clock time of the entry, e.g. "18:42" */
  function time(enteredAt: string): string {
    return new Date(enteredAt).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return { duration, time };
}
