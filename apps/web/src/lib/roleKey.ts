import type { PublicUser } from "@opengym/shared";

export function roleKey(
  role: PublicUser["role"],
): "Owner" | "Administrator" | "Staff" | "Member" {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Administrator";
  if (role === "staff") return "Staff";
  return "Member";
}
