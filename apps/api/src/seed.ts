import { auth } from "./auth.js";
import { userCollection } from "./db.js";
import { env } from "./env.js";
import {
  INITIAL_ADMIN_EMAIL,
  INITIAL_ADMIN_PHONE,
  resolveInitialAdminPassword,
  runAsInitialAdminSeed,
} from "./initialAdmin.js";

export { INITIAL_ADMIN_EMAIL } from "./initialAdmin.js";

/**
 * Initial setup: creates the default admin account if no admin exists.
 * The account starts with mustChangePassword=true; no admin endpoint works
 * until the password is changed at first sign-in (US-2).
 *
 * Resolving the password BEFORE the write means a production deployment with no
 * INITIAL_ADMIN_PASSWORD aborts startup rather than seeding a half-built admin.
 */
export async function seedInitialAdmin(): Promise<void> {
  const users = userCollection();
  const existingAdmin = await users.findOne({ role: "admin" });
  if (existingAdmin) return;

  const password = resolveInitialAdminPassword();

  await runAsInitialAdminSeed(() =>
    auth.api.signUpEmail({
      body: {
        email: INITIAL_ADMIN_EMAIL,
        password,
        name: "Salon Yöneticisi",
        firstName: "Salon",
        lastName: "Yöneticisi",
        phone: INITIAL_ADMIN_PHONE,
        dataProcessingAccepted: true,
        privacyAccepted: true,
      },
    }),
  );

  await users.updateOne(
    { email: INITIAL_ADMIN_EMAIL },
    {
      $set: {
        role: "admin",
        mustChangePassword: true,
        emailVerified: true,
      },
    },
  );

  // The password is never printed in production: container logs are collected,
  // shipped and retained, so logging the bootstrap credential would re-create
  // the exposure this seed path was hardened against. In development it is the
  // repository-visible default anyway, and printing it keeps `pnpm dev` usable.
  const credentialHint =
    env.nodeEnv === "production"
      ? "password: the configured INITIAL_ADMIN_PASSWORD"
      : `password: ${password}`;

  console.log(
    `[seed] Initial admin created: ${INITIAL_ADMIN_EMAIL} (${credentialHint}; password change required at first sign-in)`,
  );
}
