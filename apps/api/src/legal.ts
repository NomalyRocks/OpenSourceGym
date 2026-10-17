import type { Db } from "mongodb";
import type { LegalConfig } from "@opengym/shared";
import { findChainSettings } from "./db.js";

/**
 * OpenGym contains no region-specific legal text. The disclosure/data
 * processing notice and privacy policy are documents prepared and published by
 * the gym operator under its applicable law (KVKK, GDPR, CCPA...); the product
 * stores only the document URLs and version (see docs/legal/README.md).
 *
 * Default URLs are `null`: registration still works before configuration, and
 * consent checkboxes are simply shown without links.
 */
export const LEGAL_DEFAULTS: LegalConfig = {
  dataProcessingUrl: null,
  privacyUrl: null,
  version: 1,
};

// Optional "legal" object of the settings._id: "chain" singleton,
// Shallow-merged over the defaults
export async function getLegalConfig(database?: Db): Promise<LegalConfig> {
  const doc = await (database
    ? findChainSettings(database)
    : findChainSettings());
  return { ...LEGAL_DEFAULTS, ...(doc?.legal ?? {}) };
}
