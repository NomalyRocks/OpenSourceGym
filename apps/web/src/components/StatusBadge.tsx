import { useTranslation } from "react-i18next";
import type { SubscriptionStatus } from "@opengym/shared";
import type { WebTranslationKey } from "../i18n/resources";

export const statusMeta: Record<
  SubscriptionStatus,
  { cls: string; label: WebTranslationKey }
> = {
  active: { cls: "ok", label: "Active" },
  frozen: { cls: "info", label: "Frozen" },
  expired: { cls: "danger", label: "Expired" },
  none: { cls: "none", label: "None" },
};

export function StatusBadge({ status }: { status: SubscriptionStatus }) {
  const { t } = useTranslation();
  const meta = statusMeta[status];
  return <span className={`badge dot ${meta.cls}`}>{t(meta.label)}</span>;
}
