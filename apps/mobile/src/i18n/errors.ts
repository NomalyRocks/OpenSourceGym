import type { TFunction } from "i18next";
import type { ApiErrorCode } from "@opengym/shared";
import { ApiError } from "../lib/api";
import type { MobileTranslationKey } from "./resources";

const codeMessages = {
  AUTH_REQUIRED: "A session is required.",
  FORBIDDEN: "You are not authorized for this operation.",
  INTERNAL_ERROR: "An unexpected error occurred. Please try again.",
  PASSWORD_CHANGE_REQUIRED: "You must change your password before continuing.",
  PAYLOAD_TOO_LARGE: "The photo can be up to 10 MB.",
  PROFILE_PHOTO_MISSING: "No photo data was provided.",
  PROFILE_PHOTO_INVALID: "The selected file is not a valid photo.",
  PROFILE_PHOTO_BUSY: "A photo operation is in progress. Please try again.",
  PROFILE_PHOTO_RATE_LIMITED:
    "You have made too many photo requests. Please wait a moment.",
  PROFILE_PHOTO_UNAVAILABLE:
    "The profile photo service is currently unavailable.",
  INVALID_REQUEST: "Invalid request.",
  RATE_LIMITED: "Too many requests. Please wait a moment.",
  INVALID_QR: "Invalid QR code. Scan the code on the turnstile again.",
  SHARING_BLOCKED:
    "Unusual activity was detected on your account. Entry is temporarily blocked. Please contact reception.",
  MOCK_LOCATION:
    "A mock location was detected. Try again using your real location.",
  UNKNOWN_DEVICE:
    "This turnstile is no longer registered. Please contact reception.",
  NO_ACTIVE_SUBSCRIPTION:
    "You do not have an active subscription. Please contact gym reception.",
  LOCATION_REQUIRED:
    "Your location could not be obtained. Grant location permission and try again.",
  OUT_OF_RANGE:
    "You do not appear to be at the gym. Entry is only available at the gym.",
  DEVICE_OFFLINE: "The turnstile is offline. Please contact reception.",
  LOCAL_FILE_READ_FAILED: "The selected photo could not be read.",
  DELETION_MEMBER_ONLY: "Only member accounts can create a deletion request.",
  DELETION_ALREADY_PENDING: "You already have a pending deletion request.",
  DELETION_NOT_PENDING: "No pending deletion request was found.",
  INVALID_PHONE_NUMBER: "Enter a valid phone number.",
  PHONE_ALREADY_EXISTS:
    "An account is already registered with this phone number.",
} satisfies Partial<
  Record<ApiErrorCode | "LOCAL_FILE_READ_FAILED", MobileTranslationKey>
>;

export function errorMessage(
  error: unknown,
  t: TFunction,
  fallback: MobileTranslationKey,
): string {
  if (error instanceof ApiError && error.code) {
    const key = codeMessages[error.code as keyof typeof codeMessages];
    if (key) return t(key);
  }
  return t(fallback);
}
