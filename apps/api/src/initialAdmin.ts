export const INITIAL_ADMIN_EMAIL = "admin@opengym.local";
export const INITIAL_ADMIN_PASSWORD = "admin1234";

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
