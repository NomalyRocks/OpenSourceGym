import type { TFunction } from "i18next";
import type { ApiErrorCode } from "@opengym/shared";
import { ApiError } from "../lib/api";
import type { WebTranslationKey } from "./resources";

const codeMessages: Record<ApiErrorCode, WebTranslationKey> = {
  AUTH_REQUIRED: "A session is required.",
  FORBIDDEN: "You are not authorized for this operation.",
  INTERNAL_ERROR: "An unexpected error occurred. Please try again.",
  INVALID_PHONE_NUMBER: "Enter a valid phone number.",
  PHONE_ALREADY_EXISTS: "This phone number is already in use.",
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
  DELETION_MEMBER_ONLY: "Only member accounts can create a deletion request.",
  DELETION_ALREADY_PENDING: "You already have a pending deletion request.",
  DELETION_NOT_PENDING: "No pending deletion request was found.",
  INVALID_DEVICE_NAME: "Enter a valid device name.",
  DEVICE_NOT_FOUND: "The device was not found.",
  PASSWORD_TOO_SHORT: "The new password must be at least 8 characters.",
  CURRENT_PASSWORD_INVALID: "The password is incorrect.",
  SEARCH_QUERY_TOO_SHORT: "Enter at least two characters to search.",
  INVALID_USER_OR_ROLE: "Invalid user or role.",
  SELF_ROLE_CHANGE: "You cannot change your own role.",
  MFA_REQUIRED: "MFA verification is required for this operation.",
  MFA_LOCKED: "Too many verification attempts. Please try again later.",
  MFA_INVALID: "The verification code is invalid or has expired.",
  USER_NOT_FOUND: "The user was not found.",
  INVALID_SUBSCRIPTION: "Select a valid user and subscription plan.",
  SUBSCRIPTION_BUSY:
    "A subscription operation is in progress. Please try again.",
  INVALID_USER: "Invalid user.",
  GYM_NAME_REQUIRED: "Gym name is required.",
  INVALID_LOCATION: "Invalid location details.",
  INVALID_CAPACITY: "Invalid capacity.",
  INVALID_AUTO_EXIT: "Invalid automatic exit time.",
  INVALID_SHARING_SETTINGS: "Invalid account sharing detection settings.",
  INVALID_REMINDER_SETTINGS: "Invalid renewal reminder settings.",
  INVALID_LEGAL_SETTINGS:
    "Invalid legal document settings (URL must be http/https).",
  INVALID_REPORT_RANGE:
    "Invalid range. Start cannot be after end and the range cannot exceed 366 days.",
  REMINDER_RECENTLY_SENT:
    "This member was already reminded within the last 24 hours.",
  NO_UPCOMING_RENEWAL: "This member has no upcoming renewal.",
  DELETION_REQUEST_NOT_FOUND: "The deletion request was not found.",
  DELETION_REQUEST_RESOLVED: "The deletion request has already been resolved.",
  DELETION_CLEANUP_FAILED:
    "Account data could not be cleaned up. Please try again.",
};

export function errorMessage(
  error: unknown,
  t: TFunction,
  fallback: WebTranslationKey,
): string {
  if (error instanceof ApiError && error.code) {
    const key = codeMessages[error.code as ApiErrorCode];
    if (key) return t(key);
  }
  return t(fallback);
}
