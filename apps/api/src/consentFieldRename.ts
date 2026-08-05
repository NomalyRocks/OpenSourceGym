import type { Db } from "mongodb";
import { db } from "./db.js";

/**
 * Bölgeye özgü `kvkk*` onay alanlarını nötr `dataProcessing*` adlarına taşır.
 * OpenGym tek bir mevzuata bağlı olmadığından alan adları da bölgeden
 * bağımsızdır; metinlerin kendisi operatörün ayarlarındaki adreslerden gelir.
 *
 * `$rename` yalnızca eski alanı taşıyan belgelerde çalışır; ikinci koşumda
 * eşleşen belge kalmaz, yani işlem doğası gereği idempotenttir. Marker
 * yalnızca raporlama ve tekrar taramayı atlamak için tutulur.
 */
const RENAME_MARKER_ID = "consent-field-rename-v1";

interface ConsentRenameMarker {
  _id: string;
  completedAt: Date;
  renamedCount: number;
}

export interface ConsentRenameReport {
  skipped: boolean;
  renamedCount: number;
}

export async function renameLegacyConsentFields(
  database: Db = db,
): Promise<ConsentRenameReport> {
  const markers = database.collection<ConsentRenameMarker>("migration_markers");
  const existingMarker = await markers.findOne({ _id: RENAME_MARKER_ID });
  if (existingMarker) {
    return { skipped: true, renamedCount: existingMarker.renamedCount };
  }

  // Eski ve yeni alan bir arada bulunursa `$rename` yeniyi eskinin değeriyle
  // ezer: eski alan bu şemada tek yazma yolu olduğundan doğru olan odur.
  // Koleksiyon kasıtlı olarak tipsiz alınır: eski alanlar `UserDocument`
  // şemasında yok, migrasyon bittiğinde de geri gelmeyecekler.
  const result = await database.collection("user").updateMany(
    {
      $or: [
        { kvkkAccepted: { $exists: true } },
        { kvkkAcceptedAt: { $exists: true } },
      ],
    },
    {
      $rename: {
        kvkkAccepted: "dataProcessingAccepted",
        kvkkAcceptedAt: "dataProcessingAcceptedAt",
      },
    },
  );

  const renamedCount = result.modifiedCount;
  await markers.updateOne(
    { _id: RENAME_MARKER_ID },
    { $set: { completedAt: new Date(), renamedCount } },
    { upsert: true },
  );
  return { skipped: false, renamedCount };
}
