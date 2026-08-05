import type { Db } from "mongodb";
import type { LegalConfig } from "@opengym/shared";
import { findGymSettings } from "./db.js";

/**
 * OpenGym hiçbir bölgeye ait hukuki metin içermez. Aydınlatma/veri işleme
 * bildirimi ve gizlilik sözleşmesi, salonu işleten tarafın kendi mevzuatına
 * (KVKK, GDPR, CCPA...) göre hazırlayıp yayımladığı belgelerdir; ürün yalnızca
 * bu belgelerin adresini ve sürümünü taşır (bkz. docs/legal/README.md).
 *
 * Varsayılan adresler `null`: kurulum yapılmadan da kayıt akışı çalışır,
 * onay kutuları yalnızca linksiz gösterilir.
 */
export const LEGAL_DEFAULTS: LegalConfig = {
  dataProcessingUrl: null,
  privacyUrl: null,
  version: 1,
};

// settings._id: "gym" tekil belgesindeki opsiyonel "legal" alt nesnesi,
// varsayılanların üzerine sığ (shallow) olarak birleştirilir
export async function getLegalConfig(database?: Db): Promise<LegalConfig> {
  const doc = await (database ? findGymSettings(database) : findGymSettings());
  return { ...LEGAL_DEFAULTS, ...(doc?.legal ?? {}) };
}
