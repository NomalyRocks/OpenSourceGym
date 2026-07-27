# MongoDB ve Redis yedekleme / geri yükleme runbook'u

> Bu runbook `docker-compose.prod.yml` production yığını içindir. Geliştirme
> ortamında aynı komutlar `-f docker-compose.prod.yml` olmadan, MongoDB/Redis
> kimlik doğrulama parametreleri olmadan ve `opengym-dev` veritabanı adıyla
> çalışır.

Production yığınındaki `mongo` ve `redis` servisleri ile bu servislerin sırasıyla
kullandığı `mongo-data` ve `redis-data` named volume'ları esas alınır. Komutlarda
kullanılan `MONGO_USER`, `MONGO_PASSWORD` ve `REDIS_PASSWORD` değerleri depo
kökündeki `.env` dosyasından kabuk ortamına yüklenir; parolaları bu dosyaya veya
komutlara gömmeyin.

## Neler yedeklenmeli?

### MongoDB: zorunlu

MongoDB üyeler, abonelikler, geçiş olayları, audit kayıtları ve KVKK silme
talepleri dahil gerçek iş verisini tutar. Düzenli MongoDB yedeği zorunludur.
Named volume'un doğrudan dosya sistemi kopyasını almak yerine, çalışan
veritabanından tutarlı bir mantıksal yedek üretmek için `mongodump` kullanın.

### Redis: normalde yeniden üretilebilir, ancak kuyruk kontrol edilmeli

Redis'teki oturumlar ve hız sınırı sayaçları yeniden üretilebilir. Bunların
kaybı kullanıcıların yeniden giriş yapmasını gerektirir; kalıcı iş verisi kaybı
değildir. Ancak `og:entry-events` kuyruğunda henüz MongoDB'ye yazılmamış geçiş
olayları bulunabilir. Redis kaybedilirse bu olaylar da kaybolabilir.

Felaket anında en güncel geçiş olaylarının korunması gerekiyorsa Redis RDB
yedeğini de alın. Planlı bakımda mümkünse önce yeni geçişleri durdurun ve
kuyruğun MongoDB'ye aktarılmasını bekleyin; yalnızca MongoDB yedeği almak,
kuyrukta bekleyen olayları kapsamaz.

### Cloudflare R2: ayrı sistem

Cloudflare R2'de tutulan profil fotoğrafları MongoDB yedeğine **dahil değildir**.
R2 için ayrı bir yedekleme, sürümleme veya çoğaltma politikası uygulanmalıdır.

## MongoDB yedeği alma

Aşağıdaki komutları depo kökünde çalıştırın. `mongodump`, çalışan `mongo`
servisinin içinde çalışır; sıkıştırılmış archive çıktısı doğrudan host üzerindeki
`backups/` dizinine yazılır.

```bash
set -a
. ./.env
set +a
mkdir -p backups
export OPENGYM_DB=opengym
export BACKUP_FILE="backups/${OPENGYM_DB}-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
docker compose -f docker-compose.prod.yml exec -T mongo mongodump \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --db "$OPENGYM_DB" \
  --archive \
  --gzip > "$BACKUP_FILE"
test -s "$BACKUP_FILE"
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
```

Komut hata verirse oluşmuş olabilecek eksik archive dosyasını geçerli yedek
saymayın. Yedek dosyasını ve `.sha256` dosyasını birlikte saklayın.

## MongoDB geri yükleme

Önce checksum'u doğrulayın:

```bash
sha256sum -c backups/opengym-20260727T020000Z.archive.gz.sha256
```

Ardından seçilen archive'ı aynı veritabanı adına geri yükleyin:

```bash
set -a
. ./.env
set +a
export OPENGYM_DB=opengym
export BACKUP_FILE=backups/opengym-20260727T020000Z.archive.gz
docker compose -f docker-compose.prod.yml exec -T mongo mongorestore \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --archive \
  --gzip \
  --drop < "$BACKUP_FILE"
```

> **Dikkat:** `--drop`, archive içindeki her koleksiyonu geri yüklemeden önce
> hedef veritabanındaki aynı adlı koleksiyonu ve mevcut verisini siler. Yanlış
> sunucuda veya yanlış yedekle çalıştırılması geri döndürülemez veri kaybına yol
> açabilir. Hedef Compose projesini, archive adını ve checksum'u çalıştırmadan
> önce doğrulayın. Uygulama yazmalarını geri yükleme süresince durdurun.

Mevcut koleksiyonları koruyarak üzerine yazmak çoğunlukla temiz bir felaket
kurtarma sonucu vermez; bu nedenle üretim geri yüklemesinden önce aşağıdaki test
prosedürünü tamamlayın.

## Yedeği ayrı veritabanında test etme

Test edilmemiş yedek, yedek sayılmaz. Her yedekleme döngüsünde veya en az ayda
bir kez archive'ı ayrı bir veritabanı adına geri yükleyip açılabildiğini ve temel
kayıt sayılarını doğrulayın.

```bash
set -a
. ./.env
set +a
export SOURCE_DB=opengym
export RESTORE_TEST_DB=opengym-restore-test
export BACKUP_FILE=backups/opengym-20260727T020000Z.archive.gz

sha256sum -c "$BACKUP_FILE.sha256"
docker compose -f docker-compose.prod.yml exec -T mongo mongorestore \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --archive \
  --gzip \
  --drop \
  --nsFrom="${SOURCE_DB}.*" \
  --nsTo="${RESTORE_TEST_DB}.*" < "$BACKUP_FILE"

docker compose -f docker-compose.prod.yml exec -T mongo mongosh "$RESTORE_TEST_DB" \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --quiet --eval '
  const names = db.getCollectionNames().sort();
  if (names.length === 0) throw new Error("Geri yüklenen koleksiyon bulunamadı");
  for (const name of names) print(name + "\t" + db.getCollection(name).countDocuments({}));
  assert.commandWorked(db.runCommand({ validate: names[0] }));
'
```

Çıktıdaki beklenen koleksiyonların ve makul kayıt sayılarının bulunduğunu
kontrol edin. Kaynak sistem hâlâ erişilebiliyorsa kritik koleksiyonların
sayılarını kaynakla karşılaştırın; canlı yazmalar nedeniyle küçük farkların
olabileceğini hesaba katın. Test bittiğinde yalnızca test veritabanını silin:

```bash
set -a
. ./.env
set +a
export RESTORE_TEST_DB=opengym-restore-test
docker compose -f docker-compose.prod.yml exec -T mongo mongosh \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --quiet --eval \
  "db.getSiblingDB('$RESTORE_TEST_DB').dropDatabase()"
```

## İsteğe bağlı Redis RDB yedeği ve geri yükleme

Önce kuyruk uzunluğunu ve dead-letter listesini kontrol edin:

```bash
set -a
. ./.env
set +a
docker compose -f docker-compose.prod.yml exec -T redis redis-cli -a "$REDIS_PASSWORD" LLEN og:entry-events
docker compose -f docker-compose.prod.yml exec -T redis redis-cli -a "$REDIS_PASSWORD" LLEN og:entry-events:dead
```

`redis-cli -a` parolayı süreç argümanlarında gösterebilir ve süreç listesine
sızdırabilir. Komutları yalnızca güvenilen sunucuda ve yetkili kullanıcıyla
çalıştırın.

RDB yedeği almak için Redis'e senkron snapshot yazdırın ve dosyayı host'a
çıkarın:

```bash
set -a
. ./.env
set +a
mkdir -p backups
export REDIS_BACKUP_FILE="backups/redis-$(date -u +%Y%m%dT%H%M%SZ).rdb"
docker compose -f docker-compose.prod.yml exec -T redis redis-cli -a "$REDIS_PASSWORD" SAVE
docker compose -f docker-compose.prod.yml cp redis:/data/dump.rdb "$REDIS_BACKUP_FILE"
test -s "$REDIS_BACKUP_FILE"
sha256sum "$REDIS_BACKUP_FILE" > "$REDIS_BACKUP_FILE.sha256"
```

Redis geri yüklemesi mevcut oturumları, sayaçları ve kuyruk durumunu yedekteki
ana döndürür. Uygulama ile Redis'i kullanan tüm süreçleri durdurduktan sonra:

```bash
set -a
. ./.env
set +a
export REDIS_BACKUP_FILE="$PWD/backups/redis-20260727T020000Z.rdb"
sha256sum -c "$REDIS_BACKUP_FILE.sha256"
docker compose -f docker-compose.prod.yml stop redis
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  -v "$REDIS_BACKUP_FILE:/restore/dump.rdb:ro" \
  redis sh -c 'cp /restore/dump.rdb /data/dump.rdb && chown redis:redis /data/dump.rdb'
docker compose -f docker-compose.prod.yml up -d redis
docker compose -f docker-compose.prod.yml exec -T redis redis-cli -a "$REDIS_PASSWORD" PING
docker compose -f docker-compose.prod.yml exec -T redis redis-cli -a "$REDIS_PASSWORD" LLEN og:entry-events
```

Bu işlem `redis-data` volume'undaki mevcut `dump.rdb` dosyasını değiştirir.
Geri yüklemeden önce doğru yedek dosyasını ve checksum'u doğrulayın.

## Zamanlama, saklama ve sunucu dışı kopya

- MongoDB yedeğini en az günlük alın. Yoğun geçiş hacminde daha kısa RPO için
  sıklığı artırın.
- Başlangıç politikası olarak günlük yedekleri 14 gün, haftalık yedekleri 8
  hafta ve aylık yedekleri 12 ay saklayın. İşletmenin hukuki ve operasyonel
  gereksinimlerine göre bu süreleri belgeleyip sınırlandırın.
- Yedekleri yalnızca OpenGym sunucusunda veya aynı fiziksel diskte tutmayın.
  Şifrelenmiş en az bir kopyayı farklı bir sunucuya ya da nesne depolamaya
  aktarın. Sunucunun ve `mongo-data` volume'unun birlikte kaybını varsayın.
- Cron işinin exit code'unu, dosya boyutunu ve checksum üretimini izleyin;
  başarısızlık için alarm kurun. Düzenli geri yükleme testlerini ayrıca
  takvimleyin ve sonucu kaydedin.

Örnek günlük cron girdisi (sunucu yolunu kuruluma göre değiştirin):

```cron
15 2 * * * cd /opt/opengym && set -a && . ./.env && set +a && mkdir -p backups && docker compose -f docker-compose.prod.yml exec -T mongo mongodump --username "$MONGO_USER" --password "$MONGO_PASSWORD" --authenticationDatabase admin --db opengym --archive --gzip > "backups/opengym-$(date -u +\%Y\%m\%dT\%H\%M\%SZ).archive.gz"
```

Cron satırını kullanmadan önce aynı komutu interaktif kabukta çalıştırın. Yarım
dosyaların geçerli yedek sanılmaması ve sunucu dışı aktarım/retention işlemleri
için üretimde komutu hata kontrolü yapan bir yedekleme betiğiyle sarmalayın.

## KVKK ve yedek güvenliği

Yedekler kişisel veri içerir. Yedek dosyalarını aktarımda ve saklandığı yerde
güçlü biçimde şifreleyin; erişimi yalnızca yetkili işletme personeliyle
sınırlandırın, erişimleri kayda alın ve şifreleme anahtarlarını yedeklerden ayrı
tutun. Saklama süresi amaçla sınırlı, belgelenmiş ve otomatik uygulanmış
olmalıdır.

Bir üyenin silme talebi onaylandığında aktif sistemdeki verisi silinse bile eski
yedeklerdeki kopyası yedeğin saklama süresi boyunca kalmaya devam edebilir. Bu
kopya normal işletim için yeniden kullanılmamalı; ilgili yedeğin belirlenmiş
saklama süresi dolduğunda otomatik olarak düşmelidir. Felaket geri yüklemesi eski
bir yedeği geri getirirse, yedek tarihinden sonra onaylanmış silme talepleri
yeniden uygulanmalıdır.

## Felaket kurtarma sırası

1. Yeni sunucuyu güvenli biçimde hazırlayın; depo/uygulama sürümünü, `.env`
   değerlerini ve şifreleme sırlarını güvenilir kaynaktan geri getirin.
2. `docker-compose.prod.yml` ile `mongo` ve `redis` servislerini başlatın.
   `.env` sırlarını güvenilir kaynaktan geri yükledikten sonra Compose,
   `mongo-data` ve `redis-data` named volume'larını oluşturur:

   ```bash
   docker compose -f docker-compose.prod.yml up -d mongo redis
   docker compose -f docker-compose.prod.yml ps
   ```

3. En yeni başarılı MongoDB yedeğinin checksum'unu doğrulayın ve MongoDB'yi
   yukarıdaki `mongorestore` prosedürüyle geri yükleyin.
4. Redis RDB yedeği tutulmuşsa ve kuyruktaki olayların kurtarılması gerekiyorsa
   Redis'i yukarıdaki prosedürle geri yükleyin. RDB yoksa boş Redis ile devam
   edin; kullanıcıların yeniden giriş yapacağını kabul edin.
5. R2 profil fotoğraflarını kendi ayrı kurtarma prosedürüyle doğrulayın/geri
   getirin.
6. API'yi ve istemcileri başlatın. Sağlık kontrolünü, yönetici girişini, üye ve
   abonelik sayılarını, son geçiş olaylarını ve audit kayıtlarını doğrulayın.
7. Yedek tarihinden sonra onaylanan KVKK silme taleplerini yeniden uygulayın;
   ardından kontrollü biçimde yeni kayıt ve turnike trafiğini açın.
