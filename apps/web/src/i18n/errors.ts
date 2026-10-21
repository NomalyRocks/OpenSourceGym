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
  ALREADY_INSIDE:
    "You are already recorded as inside. Use the exit turnstile before entering again.",
  ENTRY_COOLDOWN:
    "You have just passed through. Please wait a moment before scanning again.",
  NOT_INSIDE:
    "You are not recorded as having entered the gym, so the exit turnstile cannot open. Please contact reception.",
  NOT_ALLOWED_AT_GYM:
    "Your subscription does not include this gym. Please contact reception.",
  GYM_INACTIVE: "This gym is currently closed for entry.",
  GYM_OUT_OF_SCOPE: "You do not have access to this gym.",
  LAST_OWNER: "The last owner cannot be demoted.",
  GYM_NOT_FOUND: "The gym was not found.",
  INVALID_GYMS: "Select valid gyms within your access.",
  SUBSCRIPTION_ENDED: "This subscription period has already ended.",
  SUBSCRIPTION_NOT_FOUND: "Subscription not found.",
  MEMBER_ONLY: "This action applies to member accounts only.",
  INVALID_BAN_REASON: "Enter a ban reason of 3 to 500 characters.",
  BANNED: "This member is banned.",
  NOT_BANNED: "This member is not banned.",
  FREEZE_DISABLED: "Subscription freezing is turned off.",
  FREEZE_LIMIT_REACHED: "The yearly freeze limit has been reached.",
  ALREADY_FROZEN: "This membership is already frozen.",
  NOT_FROZEN: "This membership is not frozen.",
  NO_ACTIVE_PERIOD: "The member has no subscription period running right now.",
  INVALID_FREEZE_SETTINGS: "Invalid subscription freeze settings.",
  SUBSCRIPTION_STARTED:
    "This subscription period has already started and cannot be cancelled.",
  GYM_LOCATION_UNSET:
    "Entry is unavailable because the gym location is not configured. Please contact reception.",
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
  MEMBER_BANNED: "Unban the member before changing their role.",
  MEMBER_FROZEN: "End the member's freeze before changing their role.",
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
