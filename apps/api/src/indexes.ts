import {
  MongoServerError,
  ObjectId,
  type Db,
  type CreateIndexesOptions,
  type IndexDirection,
} from "mongodb";
import { db } from "./db.js";

// createIndex aynı anahtar + aynı seçeneklerle idempotenttir; ancak seçenekler
// DEĞİŞİRSE (ör. TTL süresi güncellenirse) Mongo IndexOptionsConflict (85) /
// IndexKeySpecsConflict (86) fırlatır ve API açılışta çökerdi. Bu durumda eski
// indeks düşürülüp yenisi kurulur. dropIndex isim ister; özel isim (options.name)
// verilmişse o kullanılır, verilmemişse Mongo'nun varsayılan adlandırması
// ("alan_yön" birleşimi) güvenle türetilebilir.
async function ensureIndex(
  database: Db,
  collection: string,
  keys: Record<string, IndexDirection>,
  options?: CreateIndexesOptions,
): Promise<void> {
  try {
    await database.collection(collection).createIndex(keys, options);
  } catch (err) {
    if (
      err instanceof MongoServerError &&
      (err.code === 85 || err.code === 86)
    ) {
      const indexName =
        options?.name ??
        Object.entries(keys)
          .map(([field, dir]) => `${field}_${String(dir)}`)
          .join("_");
      await database.collection(collection).dropIndex(indexName);
      await database.collection(collection).createIndex(keys, options);
      return;
    }
    throw err;
  }
}

// Repoda daha önce hiç Mongo indeksi yoktu — bu, ilk indeks bootstrap'ı.
// ensureIndex idempotenttir ve seçenek çakışmasında düşürüp yeniden kurar;
// her açılışta güvenle tekrar çalıştırılabilir.
export async function ensureIndexes(database: Db = db): Promise<void> {
  // phoneE164 yalnızca doğrulanıp tekilleştirilen belgelerde bulunur. Eski
  // mükerrer belgeler alanı taşımadığı için kısmi indeks onları koruyarak yeni
  // yarış koşullarını atomik biçimde engeller.
  await ensureIndex(
    database,
    "user",
    { phoneE164: 1 },
    {
      name: "user_phone_e164_unique",
      unique: true,
      partialFilterExpression: { phoneE164: { $type: "string" } },
    },
  );

  // Abonelik ekleme, QR kontrolü ve admin zaman çizelgesi kullanıcı bazında
  // en geç bitişi sıkça okur.
  await ensureIndex(
    database,
    "subscriptions",
    { userId: 1, endsAt: -1 },
    { name: "subscriptions_user_ends_at" },
  );

  // sharing_signals: 30 gün sonra otomatik silinir (TTL) + kullanıcı bazlı sorgu indeksi
  await ensureIndex(
    database,
    "sharing_signals",
    { at: 1 },
    { expireAfterSeconds: 30 * 24 * 3600 },
  );
  await ensureIndex(database, "sharing_signals", { userId: 1, at: -1 });
  // session: enforceSessionPolicy'nin oturum sayısı/eviction sorguları için
  await ensureIndex(database, "session", { userId: 1 });

  // Audit listesinin en yeni kayıtları önce getiren sıralaması için.
  // _id sıralama anahtarının parçası: imleçli sayfalama eşit zaman damgalarını
  // _id ile kırar, indeks de aynı anahtarı taşımalı.
  await ensureIndex(database, "audit_logs", { at: -1, _id: -1 });
  // Hesap silinirken kullanıcıya ait audit kayıtlarını anonimleştirmek için.
  await ensureIndex(database, "audit_logs", { actorId: 1 });
  // Eylem filtresi + zaman sıralaması birlikte kullanıldığında.
  await ensureIndex(database, "audit_logs", { action: 1, at: -1, _id: -1 });

  // Geçiş olayları listesinin en yeni kayıtları önce getiren sıralaması için.
  await ensureIndex(database, "entry_events", { at: -1, _id: -1 });
  // Hesap silinirken kullanıcıya ait geçiş olaylarını bulmak için; ayrıca üye
  // filtresiyle sayfalanan liste sorgusunu da karşılar.
  await ensureIndex(database, "entry_events", {
    userId: 1,
    at: -1,
    _id: -1,
  });
  // Cihaz filtresi + zaman sıralaması birlikte kullanıldığında.
  await ensureIndex(database, "entry_events", {
    deviceId: 1,
    at: -1,
    _id: -1,
  });

  // Silme talepleri listesinin en yeni kayıtları önce getiren sıralaması için.
  await ensureIndex(database, "deletion_requests", {
    requestedAt: -1,
    _id: -1,
  });
  // Durum filtresi + zaman sıralaması birlikte kullanıldığında.
  await ensureIndex(database, "deletion_requests", {
    status: 1,
    requestedAt: -1,
    _id: -1,
  });
  // Kullanıcının en son silme talebini bulmak için.
  await ensureIndex(database, "deletion_requests", {
    userId: 1,
    requestedAt: -1,
  });

  // Bir üyenin aynı anda birden çok BEKLEYEN silme talebi olamaz. Route'taki
  // "önce oku sonra yaz" kontrolü atomik değil; tekilliği fiilen sağlayan bu
  // kısmi unique indekstir. Kısmi olması şart: sonuçlanmış talepler geçmiş
  // kaydı olarak kullanıcı başına birden çok kez birikir.
  await dedupePendingDeletionRequests(database);
  await ensureIndex(
    database,
    "deletion_requests",
    { userId: 1 },
    {
      name: "deletion_requests_pending_unique",
      unique: true,
      partialFilterExpression: { status: "pending" },
    },
  );

  // Cihaz listesinin en yeni kayıtları önce getiren sıralaması için.
  await ensureIndex(database, "devices", { createdAt: -1 });

  // Faz E — raporlama: aralık sayımları ve CSV dışa aktarma createdAt'e göre
  // filtreleyip sıralar.
  await ensureIndex(database, "subscriptions", { createdAt: 1 });
  await ensureIndex(database, "user", { role: 1, createdAt: 1 });

  // Faz E — hatırlatma tekilliği. Otomatik süpürme aynı abonelik + aynı eşik
  // için ikinci kez posta göndermemeli; bunu fiilen sağlayan bu indekstir,
  // "önce oku sonra yaz" kontrolü değil. Kısmi olması şart: personelin elle
  // gönderdiği hatırlatmalar (automatic: false) tekrarlanabilir olmalı.
  await ensureIndex(
    database,
    "renewal_reminders",
    { subscriptionId: 1, thresholdDays: 1 },
    {
      name: "renewal_reminders_threshold_unique",
      unique: true,
      partialFilterExpression: { automatic: true },
    },
  );
  // Bir aboneliğin en son hatırlatmasını okumak için (elle gönderim bekleme
  // süresi ve liste sütunu).
  await ensureIndex(database, "renewal_reminders", {
    subscriptionId: 1,
    sentAt: -1,
  });
}

/**
 * Unique indeks kurulmadan önceki yarıştan kalmış mükerrer bekleyen talepleri
 * toplar: kullanıcının EN ESKİ talebi (asıl niyeti) kalır, sonradan aynı anda
 * açılmış kopyalar silinir. Bu adım olmadan createIndex E11000 ile açılışı
 * düşürürdü.
 */
async function dedupePendingDeletionRequests(database: Db): Promise<void> {
  const duplicates = await database
    .collection("deletion_requests")
    .aggregate<{ _id: ObjectId; ids: ObjectId[] }>([
      { $match: { status: "pending" } },
      // Sıralama $group'tan önce gelmeli: ids dizisinin ilk elemanının en eski
      // talep olduğu garantisi buradan geliyor.
      { $sort: { requestedAt: 1, _id: 1 } },
      { $group: { _id: "$userId", ids: { $push: "$_id" } } },
      { $match: { $expr: { $gt: [{ $size: "$ids" }, 1] } } },
    ])
    .toArray();

  for (const group of duplicates) {
    // slice(1): ObjectId'ler === ile karşılaştırılamaz (referans eşitliği),
    // bu yüzden korunacak kaydı filtreyle değil sırayla ayırıyoruz.
    const stale = group.ids.slice(1);
    if (stale.length === 0) continue;
    await database
      .collection("deletion_requests")
      .deleteMany({ _id: { $in: stale } });
    console.warn(
      `mükerrer bekleyen silme talebi temizlendi: ${stale.length} kayıt`,
    );
  }
}
