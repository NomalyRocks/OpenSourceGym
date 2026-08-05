import type { Db } from "mongodb";
import { db } from "./db.js";

/**
 * Moves region-specific `kvkk*` consent fields to neutral `dataProcessing*`
 * names. Because OpenGym is not tied to one legal framework, the field names
 * are also region-neutral; the text itself comes from URLs in operator settings.
 *
 * `$rename` operates only on documents containing the legacy field; no matching
 * documents remain on the second run, so the operation is inherently
 * idempotent. The marker is kept only for reporting and to skip rescanning.
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

  // If the legacy and new fields coexist, `$rename` overwrites the new value
  // with the legacy one: because the legacy field was the only write path in
  // that schema, it is authoritative. The collection is intentionally untyped:
  // legacy fields are absent from `UserDocument` and will not return after migration.
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
