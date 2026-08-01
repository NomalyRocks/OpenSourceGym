# OpenGym — Geliştirme Yol Haritası

> PRD §4.1'deki fazlı çıkış planının geliştirme adımlarına bölünmüş hali.
> Eşleme: **MVP = Faz 0–3 · v1.1 = Faz 4–5 · v2.0 = Faz 6 · v2.1 = Faz 7–9**
> US-x ve KPI-x referansları [PRD.md](PRD.md) içindeki user story ve başarı kriterlerine işaret eder.

---

## Faz 0 — Temel Altyapı

**Hedef:** Monorepo iskeletini ve yerel geliştirme/kurulum ortamını ayağa kaldırmak. KPI-3'ün (kurulum < 30 dk) temeli burada atılır.

**Bağımlılıklar:** Yok (başlangıç fazı).

**İş Kırılımı:**

- [x] Monorepo kurulumu (pnpm workspaces + Turborepo)
- [x] Paket iskeleti:
  - `apps/api` — Express backend
  - `apps/web` — React admin panel (Vite)
  - `apps/mobile` — placeholder (Faz 3'te Expo ile başlatılacak)
  - `packages/shared` — ortak tipler ve validasyon şemaları
- [x] Docker Compose: MongoDB ve Redis servisleri; API host üzerinde çalışır
- [x] TypeScript yapılandırması (strict), ESLint, Prettier
- [x] Temel CI (lint + typecheck + build — GitHub Actions)
- [x] API health endpoint (`GET /health`)

**Definition of Done:** `docker compose up` ile MongoDB ve Redis ayağa kalkar; host üzerinde çalışan API'nin health endpoint'i 200 döner; CI yeşil.

---

## Faz 1 — Kimlik ve Üye Kaydı

**Hedef:** BetterAuth tabanlı kimlik altyapısı ve üye self-servis kayıt akışı (US-1).

**Bağımlılıklar:** Faz 0. Harici: SMTP sağlayıcı hesabı.

**İş Kırılımı:**

- [x] BetterAuth entegrasyonu: e-posta + şifre, oturum/token yönetimi (Mongo adapter + Redis secondary storage)
- [x] Üye kayıt API'si: isim, soyisim, E.164'e normalize ve tekilleştirilen telefon, e-posta, şifre; eski mükerrer telefonlar çatışma kaydıyla korunur
- [x] KVKK aydınlatma metni + gizlilik sözleşmesi onayları (zaman damgalı kayıt, onaysız kayıt reddedilir)
- [x] SMTP e-posta doğrulama: 6 haneli OTP, 10 dk geçerli; kod gönderimi, doğrulama ucu, kod yeniden gönderme (SMTP yapılandırılmamışsa dev'de konsola yazılır)
- [x] Doğrulanmamış hesabın girişinin engellenmesi (403 EMAIL_NOT_VERIFIED)
- [x] Şifre politikası: min. 8 karakter (BetterAuth `minPasswordLength`)
- [x] Rate limiting: kayıt 3/dk, giriş 5/dk, OTP uçları 3-5/dk (Redis üzerinde)

**Definition of Done:** US-1 kabul kriterleri uçtan uca geçer: kayıt → e-posta doğrulama → giriş. Doğrulamasız giriş ve onaysız kayıt reddedilir.

---

## Faz 2 — Admin Panel ve Roller

**Hedef:** Admin panelin çekirdeği: güvenli ilk kurulum, rol yönetimi, abonelik tanımlama (US-2, US-3 kısmi, US-6).

**Bağımlılıklar:** Faz 1 (auth altyapısı).

**İş Kırılımı:**

- [x] React admin panel iskeleti (routing, auth guard, layout)
- [x] İlk kurulum akışı: `admin@opengym.local` / `admin1234` → zorunlu şifre değişimi; şifre değişmeden tüm panel uçları middleware ile kilitli (US-2). Not: e-posta tabanlı auth + min 8 karakter politikası nedeniyle `admin:admin` yerine bu kimlik kullanıldı.
- [x] Kurulum sihirbazı iskeleti (salon adı, koordinatlar, kapasite; SMTP env ile yapılandırılıyor, MFA seçeneği Faz 5'te eklenir)
- [x] Rol sistemi: admin / staff / member
- [x] Personel ekleme: telefon, e-posta, ad veya soyad ile birleşik üye arama + rol atama (US-3 — MFA doğrulaması Faz 5'e ertelendi)
- [x] Hassas işlem loglaması (rol atama, abonelik, ayar, şifre değişimi) — `audit_logs` koleksiyonu
- [x] Abonelik tanımlama/uzatma: sunucuda ardışık takvim ayı süre paketi (1/3/6/12 ay), kullanıcı bazlı Redis kilidi ve işlemi yapan personel kaydıyla (US-6); üye tarafı için `/api/me/subscription` hazır

**Definition of Done:** US-2 tam; US-3 MFA hariç tam; US-6 kabul kriterleri geçer. Şifre değiştirilmeden hiçbir panel sayfası açılmaz.

---

## Faz 3 — Mobil Uygulama (MVP Kapanışı)

**Hedef:** Üyenin mobilden kayıt olup aboneliğini görebilmesi (US-1 mobil yüzü, US-4 doluluk hariç). Bu fazın sonunda MVP tamamlanır.

**Bağımlılıklar:** Faz 1 (kayıt API'si), Faz 2 (abonelik verisi).

**İş Kırılımı:**

- [x] React Native (Expo SDK 57) iskelet + BetterAuth istemci entegrasyonu (`@better-auth/expo` + SecureStore)
- [x] Kayıt ekranı: form alanları, KVKK/gizlilik onay kutuları, e-posta doğrulama (OTP) akışı + doğrulama sonrası otomatik giriş ve tamamlanan OTP durumunun sıfırlanması
- [x] Giriş ekranı (doğrulanmamış hesapta OTP ekranına yönlendirme + kod yeniden gönderme; oturum kapanınca eski OTP ekranı yeniden açılmaz)
- [x] Ana ekran: kalan gün sayısı, abonelik bitiş tarihi, pull-to-refresh (US-4 — doluluk oranı Faz 5'te)
- [ ] KPI-2 ölçümü: kayıt akışı < 3 dk (manuel ölçüm bekliyor)

**Definition of Done:** ✅ Emülatörde uçtan uca doğrulandı — üye mobilden kayıt oldu, OTP ile doğrulandı, admin API'den abonelik tanımlandı, mobilde "92 gün kaldı" kartı görüntülendi.

**Bilinen sorun:** İlk açılışta LogBox'ta "error during concurrent rendering, recovered" uyarısı (React 19.2 + better-auth useSession; uygulama düzgün çalışıyor, dev-only uyarı). Faz 4'te izlenecek.

---

## Faz 4 — Turnike ve QR (v1.1)

**Hedef:** QR ile turnike geçişi: Device Gateway, cihaz agent'ları, doğrulama zinciri (US-5).

**Bağımlılıklar:** Faz 3 (mobil uygulama), Faz 2 (abonelik verisi). Harici: RPi/ESP32 + röle + turnike donanımı.

**İş Kırılımı:**

- [x] Device Gateway: WebSocket sunucu, cihaz başına önceden paylaşılan token ile agent kimlik doğrulaması (token sadece oluşturmada bir kez gösterilir, sunucuda sha256 hash saklanır)
- [x] Agent referans implementasyonu (RPi ve ESP32): röle tetikleme, otomatik yeniden bağlanma, fail-closed davranış
- [x] Backend'de agent bağlantı durumu izleme (30 sn ping/pong, panelde çevrimiçi/çevrimdışı durumu, üyeye "Turnike bağlantısı şu an yok" uyarısı `gatewayOnline` bayrağı ile)
- [x] Statik QR üretimi: cihaz başına özel, süresiz, sabit QR kodu (`OGGATE1.<deviceId>.<sig>` formatı; turnikeye yapıştırılır)
- [x] Gate-scan endpoint (`POST /api/me/gate-scan`): QR imza doğrulama, abonelik, konum, hesap paylaşımı, cihaz durumu kontrolleri; WebSocket ile ilgili turnike cihazına `open` komutu gönderme
- [x] Red koşulları üyeye gösteriliyor: aktif abonelik yok / konum salon dışı (US-5)
- [x] Konum doğrulama servisi: salon koordinatı + yarıçap ayarlardan; ayarlanmamışsa kontrol atlanır
- [x] Event Queue ile geçiş loglama: Redis kuyruk → `entry_events` koleksiyonu; panelde "Geçişler" sayfası
- [x] Mobilde gate-scan ekranı (GateScan.tsx): kamera taraması (expo-camera), statik QR'ı oku (`OGGATE1.` önekli), GPS konum toplama, konum izni
- [x] Panelde "Cihazlar" sayfası (admin)

**Definition of Done:** US-5 kabul kriterleri uçtan uca test edildi; **KPI-1 ölçüldü: gate-scan (HTTP POST) + WS open komutu → turnike açılma < 2 sn (hedef < 2 sn)**; **KPI-5 doğrulandı: geçersiz denemelerin %100'ü reddedildi** (geçersiz QR, aboneliksiz üye, salon dışı konum, cihaz çevrimdışı, hesap paylaşımı senaryolarının tümü). Not: KPI-1 ölçümü artık sim agent ile yapılamıyor, curl/manuel test ile yapılmalıdır.

---

## Faz 5 — Güvenlik Sertleştirme ve Doluluk (v1.1 Kapanışı)

**Hedef:** MFA ile hassas işlemlerin korunması, doluluk oranı, KVKK akışlarının tamamlanması (US-3 tam, US-4 tam).

**Bağımlılıklar:** Faz 2 (rol sistemi), Faz 4 (turnike sayaçları — doluluk için).

**İş Kırılımı:**

- [x] MFA: TOTP (authenticator) + SMTP kod seçenekleri (better-auth `twoFactor` plugin: authenticator TOTP + e-posta kodu, 10 yedek kod hashed, giriş akışında ikinci adım)
- [x] Rol atama işlemlerinde MFA etkinse zorunlu doğrulama (US-3 tamamlanır) (`mfaCode` + `mfaMethod` zorunlu; eksikse 403 MFA_REQUIRED, yanlışsa 403 MFA_INVALID; audit mfaVerified kaydı)
- [x] Kurulum sihirbazına MFA etkinleştirme seçeneği (panelde "Güvenlik" sayfası: QR kurulum, bir kez yedek kodları, parola ile devre dışı)
- [x] Doluluk oranı: turnike giriş/çıkış sayacından anlık içerideki üye sayısı (giriş +1 Redis og:inside, çıkış -1; çıkış cihazı yoksa ayarlar "otomatik çıkış süresi" varsayılan 4 saat) — mobil ana ekrana eklenir (US-4 tamamlanır)
- [x] KVKK silme talebi akışı (üye mobilden talep → admin panelden "KVKK" sayfasında onay/red; onayda hesap/abonelikler/oturumlar/MFA silinir, geçişler anonimleştirilir)
- [x] KPI-4: Device Gateway uptime izlemesi (cihaz bağlantı/kopuş `device_status_log` koleksiyonuna; panelde Cihazlar sayfasında son 24 saat uptime %)

**Definition of Done:** US-3 ve US-4 kabul kriterleri uçtan uca test edildi (2026-07-09): MFA enable → 2FA'lı giriş → rol atamada kod zorunluluğu (eksik/yanlış/doğru), giriş/çıkış taramasıyla doluluk 0→1→0, aboneliksiz üyenin girişi reddedildi ve çıkışa izin, KVKK talep→red→yeniden talep→onay→tam silme/anonimleştirme; uptime izleme panelde görünür.

---

## Faz 6 — v2.0 (İleri)

**Hedef:** Hesap paylaşımı tespiti ve istemci sertleştirme.

**Bağımlılıklar:** Faz 5.

**İş Kırılımı:**

- [x] Hesap paylaşımı tespiti: cihaz parmak izi (SHA-256 hash, `X-Device-Fingerprint` header, mobilde `expo-application`/`expo-device`/`expo-crypto` ile hash), eş zamanlı oturum sınırı (rol bazlı: üye 2, personel/admin 5; sınır aşılınca en eski oturum sessizce rotasyon), parmak izi churn sinyali (aktif oturumlar arasında rol bazlı oturum sınırından fazla farklı cihaz parmak izi; sinyal saatte en çok bir kez üretilir), konum tutarsızlığı (120 sn içinde >1 km uzaklıkta gate-scan isteği). Sinyaller `sharing_signals` koleksiyonunda 30 gün TTL ile tutulur, audit logunda görünür. Eskalasyon: 24 saatte ≥3 sinyal birikince tüm oturumlar otomatik iptal + gate-scan 24 saat geçici kilitlenir (`SHARING_BLOCKED` hata kodu, kalıcı kilit yok). Tüm eşikler (`memberMaxSessions`, `staffMaxSessions`, `signalThreshold`, `signalWindowHours`, `qrBlockHours`) admin panelinde Ayarlar sayfasından yapılandırılabilir.
- [x] Mobil anti-debugging sertleştirme: root/jailbreak/emülatör tespiti (expo-device); pozitif tespitte QR ekranı engellenir, giriş devam edilebilir. `EXPO_PUBLIC_ANTI_DEBUG` env değişkeniyle kontrol edilir (prod derlemede varsayılan açık, geliştirme modunda kapalı).
- [x] Konum spoofing'e karşı ek sinyaller (PRD §4.2): Android'de `mocked` bayrağı gate-scan isteğinde sunucuya gönderiliyor; mock location algılanırsa gate-scan reddediliyor (`MOCK_LOCATION` hata kodu) + sinyal kaydı. iOS'ta bu bayrak desteklenmiyor (bilinen sınırlama). Giriş etkilenmiyor.
- [ ] Ek A deneysel katman (path obfuscation + cipher) — değerlendirilmedi, yapılmadı; arşivde kalmaya devam ediyor; ihtiyaç doğmadı.

**Definition of Done:** v2.0 tamamlandı. Doğrulama:
- İki farklı cihazdan sign-in edilince parmak izi churn sinyali üretilir ve `sharing_signals` kaydı oluşur.
- Mock location yapılandırılan cihazlardan gate-scan reddediliyor (`MOCK_LOCATION` hata kodu, sinyal kaydı yapılıyor).
- 24 saatte ≥3 sinyal birikince oturumlar otomatik iptal + gate-scan 24 saat geçici kilitlenir (`SHARING_BLOCKED`); 24 saat sonra otomatik açılır.
- Tüm eşikler (`memberMaxSessions`, `staffMaxSessions`, `signalThreshold`, `signalWindowHours`, `qrBlockHours`) admin panelinde Ayarlar sayfasından yapılandırılabilir.
- Repo lint/typecheck/build yeşil.

---

## Faz 7 — Üye Profil Fotoğrafı

**Hedef:** Üyenin mobil uygulamadan profil fotoğrafı ekleyebilmesi ve fotoğrafın
personel panelinde görüntülenebilmesi.

- [x] Galeriden kare fotoğraf seçme, değiştirme ve kaldırma akışı
- [x] API tarafında 10 MB sınırı, güvenli görsel doğrulama ve 1024×1024 JPEG normalizasyonu
- [x] Cloudflare R2 saklama, public CDN URL'si ve KVKK hesap silme temizliği
- [x] Mobil ana ekran ve personel üye aramasında avatar/fallback gösterimi
- [x] Backend testleri, lint, typecheck ve build doğrulaması

---

## Faz 8 — Türkçe / İngilizce Yerelleştirme

**Hedef:** Yönetim paneli ve mobil uygulamada cihaz dilini izleyen, kullanıcı
tercihini kalıcı olarak saklayan iki dilli deneyim.

- [x] Web ve mobil için ortak `i18next` / `react-i18next` çeviri altyapısı
- [x] İlk açılışta cihaz/tarayıcı dili (`tr` veya `en`), diğer dillerde İngilizce fallback
- [x] TR/EN manuel dil seçici ve web `localStorage` / mobil `SecureStore` kalıcılığı
- [x] Tüm kullanıcı metinleri ile tarih ve sayı biçimlerinin aktif dile bağlanması
- [x] iOS native izin metinlerinin Türkçe ve İngilizce yerelleştirilmesi
- [x] API hataları için istemciden bağımsız kararlı `code` sözleşmesi
- [x] Sözlük eşliği, dil çözümleme ve API hata yanıtı testleri; lint, typecheck ve build doğrulaması

---

## Faz 9 — Üye Araçları: Günlük Kalori ve Makrolar

**Hedef:** Üyenin kişisel verilerini saklamadan, mobil uygulama içinde günlük
bakım/hedef kalorisi ile genel makro dağılımını tahmin edebilmesi (US-7).

**Bağımlılıklar:** Faz 8 (TR/EN altyapısı ve açık/koyu tema).

**İş Kırılımı:**

- [x] Beşinci mobil alt hedef olarak Araçlar ekranı ve çalışan kalori kartı
- [x] Mifflin–St Jeor, beş hareket çarpanı, üç hedef ve AMDR içi makro dağılımları için saf TypeScript hesaplama modülü
- [x] Cinsiyet, yaş, boy, kilo, hareket ve hedef için ayrı tam ekran adımlar; metrik/imperial dönüşümü
- [x] OpenGym temasını izleyen ilerleme/geri akışı ve iki özgün low-poly ahtapot splash illüstrasyonu
- [x] Sonuçta hedef kalorisi, bakım kalorisi, makro gram/yüzdeleri, yöntem ayrıntısı ve sağlık uyarısı
- [x] Girdilerin yalnız akış belleğinde tutulması; API, veritabanı ve SecureStore yazımı olmaması
- [x] TR/EN, açık/koyu tema, büyük yazı, ekran okuyucu, azaltılmış hareket ve Android sistem geri desteği
- [x] Formül/birim/sınır testleri ile mobil lint, typecheck, test ve kök CI doğrulaması
- [ ] KVM erişimli Android emülatörde tam akış ve açık/koyu tema görsel duman testi

**Definition of Done:** US-7 kabul kriterleri geçer; Android emülatörde tam akış
ve iki tema doğrulanır; tüm depo kontrolleri yeşildir. Otomatik kontroller ve Android
üretim paketi doğrulandı; mevcut çalışma ortamında `/dev/kvm` bulunmadığı için
emülatör görsel kontrolü bekliyor.
