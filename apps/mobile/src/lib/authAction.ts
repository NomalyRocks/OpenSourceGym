/**
 * Shared structure for "submit" flows on authentication screens.
 *
 * The BetterAuth client RETURNS API errors as `{ error }`, but a network/TLS
 * problem THROWS an exception. Because screens handled only the `{ error }`
 * path, a dropped connection never reached `setBusy(false)`: the button stayed
 * busy forever and the user could not retry without closing the screen.
 *
 * Here, `finally` always resets the busy flag, and the caught exception is
 * converted into a user-facing message.
 */
export async function runAuthAction(
  setBusy: (value: boolean) => void,
  onUnreachable: () => void,
  action: () => Promise<void>,
): Promise<void> {
  setBusy(true);
  try {
    await action();
  } catch (err) {
    // All exceptions are shown as "could not connect"; log the actual cause to
    // the developer console so it is not hidden.
    console.error("authentication request failed:", err);
    onUnreachable();
  } finally {
    setBusy(false);
  }
}
