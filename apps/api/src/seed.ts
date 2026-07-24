import { auth } from "./auth.js";
import { userCollection } from "./db.js";
import {
  INITIAL_ADMIN_EMAIL,
  INITIAL_ADMIN_PASSWORD,
  INITIAL_ADMIN_PHONE,
  runAsInitialAdminSeed,
} from "./initialAdmin.js";

export { INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD } from "./initialAdmin.js";

/**
 * İlk kurulum: hiç admin yoksa varsayılan admin hesabı oluşturur.
 * Hesap mustChangePassword=true ile açılır; ilk girişte şifre
 * değiştirilmeden hiçbir admin ucu çalışmaz (US-2).
 */
export async function seedInitialAdmin(): Promise<void> {
  const users = userCollection();
  const existingAdmin = await users.findOne({ role: "admin" });
  if (existingAdmin) return;

  await runAsInitialAdminSeed(() =>
    auth.api.signUpEmail({
      body: {
        email: INITIAL_ADMIN_EMAIL,
        password: INITIAL_ADMIN_PASSWORD,
        name: "Salon Yöneticisi",
        firstName: "Salon",
        lastName: "Yöneticisi",
        phone: INITIAL_ADMIN_PHONE,
        kvkkAccepted: true,
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

  console.log(
    `[seed] İlk admin oluşturuldu: ${INITIAL_ADMIN_EMAIL} / ${INITIAL_ADMIN_PASSWORD} (ilk girişte şifre değişimi zorunlu)`,
  );
}
