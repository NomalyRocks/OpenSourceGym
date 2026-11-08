import { ApiError } from "./api";

/** Only a definite rejection lets the operator edit and submit a new payload. */
export function isDefinitiveSaleRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== "SUBSCRIPTION_BUSY" &&
    !(error.status === 409 && error.code === "REQUEST_ID_CONFLICT")
  );
}

export function defaultPaymentGym(
  gyms: readonly { id: string }[],
  selectedGymId: string,
): string {
  return (gyms.find((gym) => gym.id === selectedGymId) ?? gyms[0])?.id ?? "";
}
