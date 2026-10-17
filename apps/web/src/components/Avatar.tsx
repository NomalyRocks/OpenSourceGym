import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PublicUser } from "@opengym/shared";
import { dateLocale } from "../i18n/format";

/** Stable 0–359 hue derived from a string, so a person keeps their colour. */
function hueOf(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Profile photo, or initials on a coloured circle when there is none. */
export function Avatar({
  member,
  large = false,
}: {
  member: Pick<PublicUser, "id" | "firstName" | "lastName" | "profilePhotoUrl">;
  large?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [failed, setFailed] = useState(false);
  const initials =
    `${member.firstName[0] ?? ""}${member.lastName[0] ?? ""}`.toLocaleUpperCase(
      dateLocale(i18n.resolvedLanguage),
    ) || "?";
  return (
    <span
      className={`avatar member-avatar${large ? " member-avatar-large" : ""}`}
      style={{ ["--hue" as string]: hueOf(member.id) }}
    >
      {member.profilePhotoUrl && !failed ? (
        <img
          src={member.profilePhotoUrl}
          alt={t("Profile photo of {{name}}", {
            name: `${member.firstName} ${member.lastName}`,
          })}
          onError={() => setFailed(true)}
        />
      ) : (
        initials
      )}
    </span>
  );
}
