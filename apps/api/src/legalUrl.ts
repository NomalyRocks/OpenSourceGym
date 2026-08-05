import { z } from "zod";

export const LEGAL_DOCUMENT_URL_PATTERN = "^https?://";

/** Operatörün hukuki belgeleri yalnızca web üzerinden açılabilmelidir. */
export const legalDocumentUrlSchema = z
  .url()
  .refine(
    (value) => {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    },
    { message: "Hukuki belge URL'si HTTP veya HTTPS kullanmalıdır." },
  )
  .meta({
    description: "Yalnızca HTTP(S) ile erişilebilen hukuki belge adresi",
    override: {
      type: "string",
      format: "uri",
      pattern: LEGAL_DOCUMENT_URL_PATTERN,
    },
  });
