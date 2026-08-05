import { z } from "zod";

export const LEGAL_DOCUMENT_URL_PATTERN = "^https?://";

/** The operator's legal documents must be accessible only over the web. */
export const legalDocumentUrlSchema = z
  .url()
  .refine(
    (value) => {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    },
    { message: "Legal document URL must use HTTP or HTTPS." },
  )
  .meta({
    description: "Legal document URL accessible only via HTTP(S)",
    override: {
      type: "string",
      format: "uri",
      pattern: LEGAL_DOCUMENT_URL_PATTERN,
    },
  });
