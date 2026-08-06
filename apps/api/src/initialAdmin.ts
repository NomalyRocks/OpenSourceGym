import { env } from "./env.js";

export const INITIAL_ADMIN_EMAIL = "admin@opengym.local";

/**
 * Development only. A fixed password keeps `pnpm dev` usable against an empty
 * database without any configuration, and it is worthless to an attacker
 * because a development install is not meant to be reachable.
 */
export const DEV_INITIAL_ADMIN_PASSWORD = "admin1234";

/**
 * Applies to the operator-supplied production password only; the development
 * default is deliberately shorter and is never used in production.
 */
export const INITIAL_ADMIN_PASSWORD_MIN_LENGTH = 12;

/**
 * Resolves the password the very first administrator is created with.
 *
 * Production has NO default. A shipped default would mean every fresh or reset
 * deployment briefly accepts a password published in this repository, and
 * `mustChangePassword` does not close that window: the flag guarantees the
 * password is replaced, not that the operator is the one replacing it (the
 * initial-password route is exempt from the flag by design). So an unset
 * INITIAL_ADMIN_PASSWORD fails the boot instead of seeding a known account.
 */
export function resolveInitialAdminPassword(): string {
  return resolveInitialAdminPasswordFrom({
    nodeEnv: env.nodeEnv,
    supplied: env.initialAdminPassword,
  });
}

/** Pure form of {@link resolveInitialAdminPassword}, so tests can vary the environment. */
export function resolveInitialAdminPasswordFrom({
  nodeEnv,
  supplied,
}: {
  nodeEnv: string;
  supplied: string | undefined;
}): string {
  if (nodeEnv !== "production") {
    return supplied ?? DEV_INITIAL_ADMIN_PASSWORD;
  }

  if (!supplied) {
    throw new Error(
      "INITIAL_ADMIN_PASSWORD must be set in production: no administrator " +
        "exists yet and this deployment ships no default bootstrap password. " +
        "Generate one with `openssl rand -base64 24`, set it in the " +
        "environment, and start the API again.",
    );
  }

  // Checked before the length rule so that copying the development password
  // into production reports the actual mistake instead of "too short".
  if (supplied === DEV_INITIAL_ADMIN_PASSWORD) {
    throw new Error(
      "INITIAL_ADMIN_PASSWORD must not be the development default.",
    );
  }

  if (supplied.length < INITIAL_ADMIN_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `INITIAL_ADMIN_PASSWORD must be at least ${INITIAL_ADMIN_PASSWORD_MIN_LENGTH} characters.`,
    );
  }

  return supplied;
}

// The initial setup account uses this internal sentinel to avoid reserving a
// phone number that could belong to a real member. Only the email and phone
// match in the startup hook accepts this value.
export const INITIAL_ADMIN_PHONE = "-";

let seedInProgress = false;

/**
 * The sentinel phone is accepted only by the internal seed call that runs before
 * the server starts listening. An HTTP client that knows the email and phone
 * values cannot activate this scope.
 */
export async function runAsInitialAdminSeed<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (seedInProgress) {
    throw new Error("Initial admin seed is already running.");
  }
  seedInProgress = true;
  try {
    return await operation();
  } finally {
    seedInProgress = false;
  }
}

export function isInitialAdminSeedInput(
  email: unknown,
  phone: unknown,
): boolean {
  return (
    seedInProgress &&
    email === INITIAL_ADMIN_EMAIL &&
    phone === INITIAL_ADMIN_PHONE
  );
}
