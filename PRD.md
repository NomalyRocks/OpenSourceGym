# OpenGym — Ürün Gereksinim Dokümanı (PRD)

> **Sürüm:** 1.1 · **Tarih:** 2026-07-31 · **Durum:** Taslak

---

## 1. Yönetici Özeti

### Problem

Spor salonları, üye kayıt ve turnike otomasyonu için yüksek katılım bedelli (kurulum + aylık lisans) SaaS çözümlerine mahkûm. Küçük ve orta ölçekli salonlar bu maliyeti karşılayamıyor; üye kaydını ve giriş kontrolünü manuel yürütmek zorunda kalıyor.

### Çözüm

OpenGym: modern, self-hosted, açık kaynak bir spor salonu otomasyon sistemi (monorepo). Tek salon kendi sunucusunda çalıştırır; üye kaydı, abonelik takibi, QR ile turnike geçişi ve personel yönetimini tek pakette sunar. Lisans veya katılım bedeli yoktur.

### Başarı Kriterleri

| #   | KPI                                                           | Hedef              |
| --- | ------------------------------------------------------------- | ------------------ |
| 1   | QR okutma → turnike açılma süresi                             | < 2 sn (uçtan uca) |
| 2   | Üye self-servis kayıt süresi (mobil)                          | < 3 dk             |
| 3   | Tek sunucuya kurulum süresi (Docker Compose ile)              | < 30 dk            |
| 4   | Turnike servisi (Device Gateway) uptime                       | ≥ %99              |
| 5   | Aboneliksiz / konum dışı geçiş denemelerinin reddedilme oranı | %100               |

---

## 2. Kullanıcı Deneyimi ve İşlevsellik

### 2.1 Personalar

- **Salon Sahibi / Admin:** Sistemi kurar, personel ekler, tüm yetkilere sahiptir.
- **Personel:** Üye aboneliklerini tanımlar/uzatır, üye kayıtlarını yönetir.
- **Üye:** Mobil uygulamadan kayıt olur, aboneliğini takip eder, QR ile salona girer.

### 2.2 User Story'ler ve Kabul Kriterleri

#### US-1: Üye Kaydı

> Üye olarak, mobil uygulamadan kendim kayıt olmak istiyorum ki resepsiyonda beklemeden sisteme dahil olayım.

**Kabul Kriterleri:**

- Kayıt formu alanları: isim, soyisim, telefon numarası, e-posta, şifre.
- Gizlilik sözleşmesi ve KVKK aydınlatma metni onayları zorunlu (onaysız kayıt tamamlanamaz; onay zaman damgasıyla saklanır).
- SMTP ile e-posta doğrulama kodu gönderilir; doğrulanmamış hesap giriş yapamaz.
- Şifre politikası: min. 8 karakter (BetterAuth `minPasswordLength`).

#### US-2: Admin İlk Kurulum

> Salon sahibi olarak, sistemi güvenli varsayılanlarla kurmak istiyorum ki ilk günden açık kapı bırakmayayım.

**Kabul Kriterleri:**

- İlk girişte hesap `admin@opengym.local` / `admin1234` (e-posta tabanlı kimlik doğrulama ve min. 8 karakter şifre politikası gereği `admin:admin` yerine); girişin hemen ardından **zorunlu şifre değiştirme** ekranı gelir, atlanamaz.
- Şifre değiştirilmeden panelin başka hiçbir sayfasına erişilemez.
- Kurulum sihirbazında MFA etkinleştirme seçeneği sunulur (zorunlu değil, önerilir).

#### US-3: Personel Ekleme

> Admin olarak, uygulamayla kayıt olmuş bir kişiyi telefon numarasıyla arayıp personel olarak atamak istiyorum.

**Kabul Kriterleri:**

- Admin panelde telefon numarasıyla üye araması yapılır; bulunan hesaba personel rolü atanır.
- Rol atama (personel/admin) hassas işlemdir: MFA etkinse authenticator kodu veya SMTP ile gönderilen kod doğrulanmadan tamamlanamaz.
- Gerekçe: admin hesabı ele geçirilirse saldırganın istediği hesaba adminlik/üyelik vermesini zorlaştırmak.

#### US-4: Abonelik Görüntüleme (Mobil)

> Üye olarak, uygulamayı her açtığımda abonelik durumumu görmek istiyorum ki üyeliğimin ne zaman biteceğini bileyim.

**Kabul Kriterleri:**

- Ana ekranda: kalan gün sayısı, abonelik bitiş tarihi.
- Salon doluluk bilgisi: anlık içerideki üye sayısı ve doluluk oranı (hesaplama yöntemi: turnike giriş/çıkış sayacı — çıkış turnikesi yoksa yöntem `TBD`).

#### US-5: QR ile Turnike Geçişi

> Üye olarak, turnikeye yapıştırılmış QR'ı telefonumla okutup turnikeden geçmek istiyorum ki kart/anahtarlık taşımayayım.

**Kabul Kriterleri:**

- Gate-scan isteği gönderildiğinde (turnikeye yapıştırılmış statik QR okunduğunda), backend doğrulama sonrası turnikenin bağlı olduğu WebSocket kanalına açma sinyali gönderir.
- **Red koşulları:**
    - Aktif aboneliği yoksa → istek reddedilir, kullanıcıya nedeni gösterilir.
    - Konumu salon koordinatlarında değilse → istek reddedilir.
- Uçtan uca gecikme < 2 sn (KPI-1).
- WebSocket bağlantısı kopuksa üyeye anlaşılır hata gösterilir; turnike asla "açık" durumda takılı kalmaz (fail-closed).

#### US-6: Abonelik Tanımlama (Personel)

> Personel olarak, salonda ödemesini alan üyeye panelden abonelik tanımlamak istiyorum.

**Kabul Kriterleri:**

- Personel, üyeyi arayıp abonelik başlangıç/bitiş tarihi (veya süre paketi) tanımlar/uzatır.
- Her abonelik işlemi hangi personelin yaptığıyla birlikte loglanır (audit trail).

#### US-7: Günlük Kalori ve Makro Hesaplama (Mobil)

> Üye olarak, temel vücut bilgilerim ve hareket seviyemle günlük kalori ve
> makro tahminimi görmek istiyorum ki antrenman hedefimi daha bilinçli
> planlayabileyim.

**Kabul Kriterleri:**

- Mobil alt menüde ayrı bir **Araçlar** hedefi ve çalışan günlük kalori kartı bulunur.
- Cinsiyet, yaş, boy, kilo, hareket seviyesi ve hedef girdileri ayrı adımlarda alınır; metrik ve imperial birimler desteklenir.
- Bakım kalorisi Mifflin–St Jeor denklemi ve beş hareket çarpanıyla; hedef kalorisi yağ kaybında -%15, korumada %0, kas kazanımında +%10 ile hesaplanır.
- Sonuç hedef kaloriyi, bakım kalorisini ve hedefe göre protein/karbonhidrat/yağ gramlarını gösterir; genel yetişkinlere yönelik bir tahmin olduğu açıkça belirtilir.
- Araç 18–80 yaş, 120–230 cm ve 35–300 kg aralıklarını doğrular. Tüm girdiler cihazda (SecureStore) oturum açan üyeye özel bir anahtar altında saklanarak hesaplayıcı yeniden açılışında otomatik doldurulmaya olanak tanır ve çıkışta silinir; yaş, boy (cm) ve kilo (kg) ayrıca üyenin sunucu profiline yazılır ve Profil sayfasından da güncellenebilir. Bu alanların tek yazma yolu rol denetiminden geçen `PATCH /api/me/body-metrics` ucudur; kilo geçmişi üyenin hesabı silindiğinde birlikte silinir. Takvim, hesaplanmış günlük kalori hedefini seçili günün detay kartında gösterir.

### 2.3 Non-Goals (Kapsam Dışı)

- **Online ödeme entegrasyonu yok.** Ödeme salonda alınır; abonelik personel tarafından manuel tanımlanır.
- **Multi-tenant / çoklu şube yok.** Her kurulum tek salona hizmet eder (single-tenant, self-hosted).
- **Ders/rezervasyon, antrenman programı, diyet takibi, öğün planlama veya beslenme koçluğu yok.** Genel yetişkinler için tahmin üreten bilgilendirici kalori/makro hesaplayıcısı bu sınırın istisnasıdır (girdileri cihazda saklar, boy/kiloyu ayrıca üyenin sunucu profiline yazar — bkz. US-7).
- **Path obfuscation ve custom cipher katmanı bu sürümde uygulanmayacak** (bkz. §3.4 ve Ek A).

---

## 3. Teknik Spesifikasyonlar

### 3.1 Teknoloji Yığını

| Katman           | Teknoloji                                  |
| ---------------- | ------------------------------------------ |
| Backend          | TypeScript, Express                        |
| Auth             | BetterAuth                                 |
| Veritabanı       | MongoDB                                    |
| Cache            | Redis                                      |
| Obje Depolama    | Cloudflare R2                              |
| Web Panel        | React                                      |
| Mobil Uygulama   | React Native                               |
| Cihaz Agent'ları | Raspberry Pi / ESP32 (WebSocket istemcisi) |

### 3.2 Mimari

```
OpenGym Backend
├── REST API
├── Admin Panel
├── Mobile App API
├── Device Gateway (WebSocket)
└── Event Queue

                    │
             Secure WebSocket
                    │
        ┌───────────┴───────────┐
        │                       │
 Raspberry Pi Agent        ESP32 Agent
        │                       │
      Röle                    Röle
        │                       │
     Turnike A              Turnike B
```

**Gate-scan (QR geçiş) veri akışı:**

1. Mobil uygulama turnikeye yapıştırılmış statik QR'ı okutur, backend'e POST isteği (gate-scan endpoint) gönderir.
2. Backend abonelik + konum + hesap paylaşımı + cihaz durumu doğrulaması yapar.
3. Doğrulama geçerse Device Gateway, ilgili turnikenin agent'ına WebSocket üzerinden açma sinyali yollar.
4. Agent röleyi tetikler, turnike açılır; sonuç Event Queue'ya loglanır.

### 3.3 Entegrasyon Noktaları

- **SMTP:** e-posta doğrulama ve MFA kodu gönderimi (sağlayıcı `TBD`, kurulumda yapılandırılır).
- **Device Gateway:** turnike agent'ları ile kalıcı Secure WebSocket bağlantısı; agent kimlik doğrulaması `TBD` (öneri: cihaz başına önceden paylaşılan token).
- **Konum servisi:** mobil cihazın GPS konumu, salon koordinatları + yarıçap ile karşılaştırılır.

### 3.4 Güvenlik ve Gizlilik

**Birincil katman (zorunlu):**

- Tüm trafik TLS üzerinden.
- BetterAuth ile oturum/token yönetimi.
- Hassas uçlarda (giriş, rol atama, QR doğrulama) rate limiting.
- MFA: authenticator (TOTP) veya SMTP kod; kurulumda opsiyonel, rol atama gibi hassas işlemlerde etkinse zorunlu.
- KVKK uyumu: aydınlatma metni ve açık rıza kaydı, kişisel verilerin amaçla sınırlı işlenmesi, silme talebi akışı `TBD`.

**İstemci tarafı önlemler:**

- Mobil uygulamada anti-debugging koruması.
- Konum izni: üyenin gerçekten salonda olduğunun doğrulanması (US-5).
- Telefon/cihaz sinyalleri: hesabın birden fazla kişi tarafından paylaşılıp paylaşılmadığının tespiti. Sinyal seti: cihaz parmak izi (SHA-256 hash, `X-Device-Fingerprint` header; mobilde `expo-application`/`expo-device`/`expo-crypto` ile hesaplanır), eş zamanlı oturum sınırı (rol bazlı: üye 2, personel/admin 5), parmak izi churn (24 saatlik pencerede ≥3 farklı cihaz), konum tutarsızlığı (120 sn içinde >1 km). Eskalasyon: 24 saatte ≥3 sinyal birikince tüm oturumlar otomatik iptal + QR üretimi 24 saat geçici kilitlenir (`SHARING_BLOCKED`).

**Deneysel — bu sürümde uygulanmayacak:**

- Path obfuscation (senkron PRNG + SHA256 hash routing) ve custom cipher tasarımı Ek A'da korunmuştur. Riskleri: security-through-obscurity (tek başına koruma sağlamaz), istemci-sunucu PRNG desenkronizasyon kırılganlığı, custom crypto'nun kanıtlanmamışlığı. İleride ihtiyaç doğarsa birincil katmanın **üzerine** deneysel ek katman olarak değerlendirilebilir.

---

## 4. Riskler ve Yol Haritası

### 4.1 Fazlı Çıkış

| Faz      | Kapsam                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP**  | Üye kaydı (US-1), admin ilk kurulum (US-2), personel ekleme (US-3), abonelik tanımlama (US-6), mobil abonelik görüntüleme (US-4, doluluk hariç) |
| **v1.1** | QR + turnike WebSocket entegrasyonu (US-5), konum doğrulama, doluluk oranı, MFA                                                                 |
| **v2.0** | Hesap paylaşımı tespiti, anti-debugging sertleştirme; gerekirse deneysel güvenlik katmanı (Ek A) değerlendirmesi                                |
| **v2.1** | Üye profil fotoğrafı, Türkçe/İngilizce deneyim ve cihazda çalışan bilgilendirici üye araçları (US-7)                                            |

> Geliştirme adımlarına bölünmüş detaylı faz planı için bkz. [ROADMAP.md](ROADMAP.md) (MVP = Faz 0–3, v1.1 = Faz 4–5, v2.0 = Faz 6).

### 4.2 Teknik Riskler

| Risk                          | Etki                                   | Önlem                                                                                        |
| ----------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| WebSocket bağlantı kopması    | Üyeler turnikeden geçemez              | Agent'ta otomatik yeniden bağlanma + backend'de bağlantı durumu izleme; fail-closed davranış |
| Konum spoofing (sahte GPS)    | Salon dışından turnike tetikleme       | Android'de `mocked` bayrağı gate-scan isteğinde sunucuya gönderiliyor; mock location algılanırsa gate-scan reddediliyor (`MOCK_LOCATION` hata kodu). iOS'ta bu bayrak desteklenmiyor (bilinen sınırlama). Parmak izi churn ve konum tutarsızlığı sinyalleri tamamlayıcı kontrol sağlıyor; v2.0'da ek sinyaller uygulanmıştır. |
| Statik QR fotoğrafı ile uzaktan geçiş | Salon konumu yapılandırılmamışsa, QR'ın fotoğrafını çeken üye salon dışından turnikeyi açabilir (fiziksel varlık kanıtı yok) | Konum doğrulaması yapılandırıldığında mesafe kontrolü zorunlu çalışır. Konum yapılandırılmamışsa admin panelinin Cihazlar sayfasında kalıcı uyarı gösterilir. Tamamlayıcı: hesap paylaşımı sinyalleri, tarama hız sınırı ve çift tarama kilidi. |
| SMTP teslimat sorunları       | Üye kaydı/MFA tıkanır                  | Kod yeniden gönderme + teslimat hatalarının panelde görünürlüğü                              |
| Self-hosted ortam çeşitliliği | Kurulum hataları, destek yükü          | Docker Compose ile standart kurulum, KPI-3 (< 30 dk) hedefi                                  |
| `admin:admin` varsayılanı     | Kurulum sonrası unutulursa kritik açık | Zorunlu şifre değişimi atlanamaz (US-2); değiştirilmeden hiçbir uç çalışmaz                  |
| Kalori tahmininin reçete sanılması | Uygun olmayan beslenme kararı | Yetişkin girdi sınırları, “tahmin” etiketi, hamilelik/emzirme ve özel sağlık durumu uyarısı; veri kaydı yok |

---

## Ek A: Deneysel Path Obfuscation Tasarımı (Uygulanmayacak — Arşiv)

> Bu bölüm orijinal tasarım notlarını korur. §3.4'te açıklanan nedenlerle bu sürümde **uygulanmayacaktır**.

### Path Obfuscation

- İstemci ve sunucu senkronize PRNG state'ine sahip olur.
- Her istekte PRNG 1 adım ilerletilir.
- İstemci URL path'i olarak `SHA256(prngN.toString() + gerçekPath)` hesaplar ve gönderir.
- Sunucu gelen hash'i alır, kendi PRNG'sini ilerletir, kayıtlı tüm rotaları dolaşarak `SHA256(prngN + routePath)` ile eşleşen rotayı bulur.
- Aynı route her istekte farklı hash üretir (PRNG ilerlediği için).
- PRNG state'i ve rotalar bilinmeden hangi route'a erişildiği tespit edilemez varsayımı.
- Rotalar `HTTP POST /routes` ile runtime'da kaydedilir.

### Cipher Sistemi

- 16 karakterli özel hex alfabesi (`xR4mYc8Wf2Ls5Hn7`).
- LCG PRNG: `a=214013, c=2531011, m=88888889` (örnek değerler).
- Rolling offset + checksum ile stateful encode/decode.

### HTTP/WS Emülatörü

- Web API tarafında HTTP/WS emülatörü; isteğin gönderileceği path gizlenir, statik path olmaz, her istek farklı path'e yönlenir.
- QR akışında da bu katman üzerinden POST gönderilmesi öngörülmüştü.
