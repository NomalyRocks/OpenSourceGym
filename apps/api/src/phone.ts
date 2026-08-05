import { parsePhoneNumberWithError } from "libphonenumber-js/max";

export const INVALID_PHONE_MESSAGE =
  "Enter a valid phone number. The country code is optional for Turkish numbers.";
export const PHONE_ALREADY_EXISTS_MESSAGE =
  "An account with this phone number already exists.";
export const PHONE_ALREADY_EXISTS_CODE = "PHONE_ALREADY_EXISTS";

export class InvalidPhoneNumberError extends Error {
  constructor() {
    super(INVALID_PHONE_MESSAGE);
    this.name = "InvalidPhoneNumberError";
  }
}

/**
 * Interprets numbers without a country code as Turkish and returns valid phone
 * numbers in E.164 format. The entire input must be a phone number; numbers are
 * not extracted from text and extensions are not accepted.
 */
export function normalizePhoneToE164(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidPhoneNumberError();
  }

  try {
    const phone = parsePhoneNumberWithError(value.trim(), {
      defaultCountry: "TR",
      extract: false,
    });

    if (!phone.isValid() || phone.ext) {
      throw new InvalidPhoneNumberError();
    }

    return phone.number;
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) throw error;
    throw new InvalidPhoneNumberError();
  }
}

/** Non-throwing version for admin search and safe reads of legacy documents. */
export function tryNormalizePhoneToE164(value: unknown): string | null {
  try {
    return normalizePhoneToE164(value);
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) return null;
    throw error;
  }
}

export function maskPhoneE164(phoneE164: string): string {
  if (phoneE164.length <= 7) return phoneE164;
  return `${phoneE164.slice(0, 3)}${"*".repeat(phoneE164.length - 7)}${phoneE164.slice(-4)}`;
}
