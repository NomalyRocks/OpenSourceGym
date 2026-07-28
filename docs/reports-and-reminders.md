# Raporlar, Yenileme Hatırlatmaları ve CSV Dışa Aktarma

Bu doküman salon sahibi ile OpenGym sunucusunu işleten kişinin raporları,
yenileme hatırlatmalarını ve veri dışa aktarmayı güvenli biçimde kullanması
içindir.

## Rapor uçları

Rapor uçları hem `admin` hem de `staff` rolüne açıktır:

- `GET /api/admin/reports/summary`
- `GET /api/admin/reports/entry-trend`

İki uç da isteğe bağlı `from` ve `to` sorgu parametrelerini kabul eder. Tarihleri
ISO 8601 biçiminde gönderin; örneğin
`?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.999Z`. Sınırlar
dahildir. `to` verilmezse istek anı, `from` verilmezse `to` değerinden 30 gün
öncesi kullanılır. `from`, `to` değerinden sonra olamaz ve aralık 366 günü
aşamaz; aksi durumda API `400 INVALID_REPORT_RANGE` döndürür.

### Özet raporu

`GET /api/admin/reports/summary` aşağıdaki alanları döndürür:

| Alan                     | Anlamı                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `range.from`, `range.to` | API'nin uyguladığı aralığın ISO zamanlarıdır.                                                                                                                                                                          |
| `timeZone`               | Günlük rapor kovalarında kullanılan IANA saat dilimidir.                                                                                                                                                               |
| `activeMembers`          | İstek anında aktif aboneliği olan benzersiz üye sayısıdır; seçilen aralıktan bağımsızdır.                                                                                                                              |
| `newMembers`             | Aralıkta oluşturulmuş ve rolü `member` olan kullanıcı sayısıdır.                                                                                                                                                       |
| `newSubscriptions`       | Aralıkta oluşturulan abonelik kaydı sayısıdır.                                                                                                                                                                         |
| `lapsedMembers`          | En geç aboneliğinin bitişi aralıkta kalan, daha sonraki bir abonelikle yenileme yapmamış benzersiz üye sayısıdır. Eski bir paketi aralıkta bitmiş olsa bile daha ileri bitişli aboneliği bulunan üye bu sayıya girmez. |
| `renewalsDue`            | En geç aboneliği istek anından başlayarak önümüzdeki 7 gün içinde bitecek benzersiz üye sayısıdır; seçilen aralıktan bağımsızdır.                                                                                      |
| `entries.total`          | Aralıktaki tüm geçiş denemeleridir.                                                                                                                                                                                    |
| `entries.allowed`        | Aralıkta izin verilen geçişlerdir.                                                                                                                                                                                     |
| `entries.denied`         | Aralıkta reddedilen geçişlerdir.                                                                                                                                                                                       |
| `entries.uniqueMembers`  | Aralıkta en az bir geçiş olayıyla ilişkilendirilen benzersiz üye sayısıdır.                                                                                                                                            |

### Günlük giriş trendi

`GET /api/admin/reports/entry-trend` yanıtındaki `range` ve `timeZone` alanları
yukarıdaki anlamdadır. `points`, aralıktaki her yerel gün için bir kayıt içerir;
geçiş olmayan günler de sıfırlarla döner.

| `points[]` alanı | Anlamı                                              |
| ---------------- | --------------------------------------------------- |
| `date`           | Salon saat dilimindeki gün, `YYYY-MM-DD` biçiminde. |
| `total`          | O gündeki tüm geçiş denemeleri.                     |
| `allowed`        | O gündeki izin verilen geçişler.                    |
| `denied`         | O gündeki reddedilen geçişler.                      |

## REPORTS_TIME_ZONE

`REPORTS_TIME_ZONE`, günlük giriş trendindeki gün sınırlarını belirler. Böylece
gece yarısına yakın bir geçiş UTC gününe göre değil, salonun yerel takvim gününe
göre gruplanır. Varsayılan değer `Europe/Istanbul` değeridir.

Değer geçerli bir IANA saat dilimi olmalıdır; örneğin `Europe/Istanbul`.
Geçersiz bir değer yapılandırma hatasıdır ve API açılışta sonlanır. Değişkeni
değiştirdikten sonra API sürecini yeniden başlatın.

## Yenileme hatırlatmaları

Salon ayarlarındaki `reminders.enabled` varsayılan olarak `false` değerindedir.
Bu güvenli varsayılan, yeni kurulumun veya sürüm yükselten mevcut kurulumun
yönetici açıkça izin vermeden üyelere toplu e-posta göndermesini önler.

Hatırlatmaları açmadan önce gerçek e-posta teslimatı için `SMTP_HOST`
yapılandırılmalıdır. Üretimde bu değişken yoksa gönderim başarısız olur.
Geliştirme ortamında ise e-posta teslim edilmez, API konsoluna yazılır.

`reminders.daysBefore`, aboneliğin bitmesine kaç gün kala otomatik hatırlatma
gönderileceğini belirler. Varsayılan eşikler `[7, 1]` değeridir. Ayar 1–5 adet,
`0` ile `90` arasında tam sayı kabul eder; `0`, aboneliğin bittiği günü ifade
eder. Bir süpürmede birden fazla eşik uygunsa kalan güne en yakın, en dar eşik
kullanılır.

API saatlik bir süpürme çalıştırır ve her üyenin yalnızca en geç aboneliğini
değerlendirir. Aynı abonelik ve aynı eşik için en fazla bir otomatik e-posta
gönderilir. Bunu `renewal_reminders_threshold_unique` adlı kısmi unique MongoDB
indeksi garanti eder. Gönderim başarısız olursa hatırlatma kaydı geri alınır ve
sonraki süpürmede yeniden denenebilir.

Yaklaşan yenilemeler `GET /api/admin/reports/renewals` ile listelenebilir.
Tek üyeye elle gönderim
`POST /api/admin/reports/renewals/:userId/remind` yoluyla yapılır. Bu iki işlem
`admin` ve `staff` rollerine açıktır.

Aynı abonelik için son gönderimin (otomatik ya da elle) üzerinden 24 saat
geçmeden ikinci bir hatırlatma gitmez. Elle denendiğinde API `429` ve
`recently-reminded` nedeni döndürür; saatlik süpürme ise o üyeyi sessizce
atlar (`cooledDown`). Bekleme süresi dolduğunda eşik yeniden değerlendirilir,
yani atlanan hatırlatma kaybolmaz.

## CSV dışa aktarma

Yalnızca `admin` rolü şu uçtan CSV indirebilir:

`GET /api/admin/reports/export?dataset=members|subscriptions|entries&from&to`

`from` ve `to`, raporlarla aynı varsayılan ve 366 günlük üst sınıra tabidir.
`members` kullanıcıları `createdAt`, `subscriptions` abonelikleri `createdAt`,
`entries` ise geçişleri `at` alanına göre seçilen aralıkta dışa aktarır.

Her indirme `audit_logs` koleksiyonuna `data-exported` eylemiyle; veri kümesi,
uygulanan `from` ve `to` değerleriyle birlikte yazılır. CSV dosyaları toplu
kişisel veri içerir. KVKK kapsamında yalnızca iş amacıyla indirin, erişimi
sınırlandırın ve gereğinden uzun saklamayın.

Dosya, Türkçe karakterlerin Excel'de doğru açılması için UTF-8 BOM ile başlar.
Formül enjeksiyonunu önlemek amacıyla `=`, `+`, `-` veya `@` ile başlayan hücre
değerlerinin başına tek tırnak eklenerek değer metin olarak etkisizleştirilir.

## Sorun giderme

Hatırlatma e-postası gitmiyorsa şu sırayla kontrol edin:

1. Salon ayarlarında `reminders.enabled` açık mı?
2. `reminders.daysBefore` boş olmayan, geçerli eşikler içeriyor mu?
3. `SMTP_HOST` tanımlı mı ve SMTP sunucusuna API sunucusundan erişilebiliyor mu?
4. Üyenin en geç aboneliği henüz bitmemiş ve yapılandırılan eşik penceresinde mi?
5. Aynı abonelik ve eşik için otomatik posta daha önce gönderilmiş mi?
6. Son otomatik veya elle hatırlatmanın üzerinden 24 saat geçti mi? (Geçmediyse
   hem elle gönderim hem süpürme atlar.)
7. API günlüğünde `yenileme hatırlatması gönderilemedi` veya SMTP hatası var mı?

Hatırlatma ayarını veya SMTP ortam değişkenlerini düzelttikten sonra SMTP
değişikliği için API'yi yeniden başlatın. Otomatik gönderim bir sonraki saatlik
süpürmede yeniden denenecektir.
