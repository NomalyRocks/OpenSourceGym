import { useTranslation } from "react-i18next";
import type { MemberPresence } from "@opengym/shared";
import { usePresenceFormat } from "../lib/presence";

/** Green dot + gym and time inside, or a muted dash when outside. */
export function PresenceBadge({
  presence,
}: {
  presence: MemberPresence | null | undefined;
}) {
  const { t } = useTranslation();
  const { duration } = usePresenceFormat();
  if (!presence) return <span className="muted">—</span>;
  return (
    <span className="presence">
      <span className="presence-dot" aria-hidden="true" />
      {t("In {{gym}} · {{duration}}", {
        gym: presence.gymName,
        duration: duration(presence.enteredAt),
      })}
    </span>
  );
}
