# OpenGym İyileştirme Raporu — Temmuz 2026

Yöntem: 5 paralel Codex keşif lane'i (salt-okunur) — API, web, mobil, altyapı/DX, ürün/roadmap
boşluğu. Lane çıktıları iddiadır; aşağıdaki P0 maddeleri kodda ayrıca doğrulandı.

Toplam 74 bulgu. Bu rapor önceliğe göre süzülmüş halidir.

---

## P0 — Önce bunlar (doğrulanmış)

| #   | Konu                                     | Yer                                                                                                    | Problem                                                                                                                                                                                           |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Graceful shutdown yok                    | `apps/api/src/index.ts:93`                                                                             | Kodda hiç `SIGTERM`/`SIGINT`/`server.close` yok. Deploy veya `docker stop` sırasında uçuşan istekler kesilir, entry-event consumer yarıda kalır, Mongo/Redis bağlantıları asılı kalır.            |
| 2   | Health check yüzeysel                    | `apps/api/src/index.ts:34`                                                                             | Sabit `status: "ok"` döner. Mongo çökse, Redis kopsa, consumer ölse bile sağlıklı görünür — self-hosted kurulumda sessiz arıza.                                                                   |
| 3   | KVKK silme talebinde race                | `apps/api/src/routes/me.ts:469`                                                                        | `findOne({status:"pending"})` → `insertOne` atomik değil. Eşzamanlı iki istek aynı üyeye iki pending talep açar. Çözüm: `{userId:1, status:1}` partial unique index + `findOneAndUpdate(upsert)`. |
| 4   | Render fazında yan etki                  | `apps/web/src/pages/Members.tsx:80`                                                                    | `if (subs === null) void load()` render içinde çağrılıyor. StrictMode'da çift istek, unmount sonrası setState. `useEffect([member.id])` olmalı.                                                   |
| 5   | Mobil auth akışları busy'de kilitleniyor | `Login.tsx:47`, `Register.tsx:72`, `VerifyOtp.tsx:39`, `ForgotPassword.tsx:28`, `ResetPassword.tsx:60` | `setBusy(true)` sonrası `try/finally` yok. Ağ hatası → promise reject → buton sonsuz spinner'da kalır. Ortak `safeAuthCall` + `finally` deseni.                                                   |
| 6   | Prod'da HTTP fallback                    | `apps/mobile/src/lib/config.ts:12`                                                                     | `EXPO_PUBLIC_API_URL` yoksa `http://…:3000`. Prod build'de zorunlu kıl + HTTPS şeması doğrula.                                                                                                    |

## P1 — Ölçeklenme ve veri katmanı

- **Pagination hiçbir liste ucunda yok.** `admin.ts:445` (audit), `:466` (geçişler), `:491` (KVKK talepleri)
  hepsi `.find({}).sort().limit(100)`. Eski kayda erişim imkânsız; veri büyüdükçe hem UI hem sorgu bozulur.
  Cursor (`before`/`limit`) + filtre parametreleri gerekiyor.
- **Index bootstrap eksik.** `indexes.ts:44` yalnız `user`, `subscriptions`, `sharing_signals`, `session`
  kapsıyor. `audit_logs.at`, `entry_events.at`, `devices.createdAt`, `deletion_requests.{status,requestedAt}`
  indexsiz — yukarıdaki sort'lar collection scan.
- **N+1:** `devices.ts:60` her cihaz için ayrı `computeUptime24h`. Aggregate'e taşı.
- **Sınırsız `.toArray()`:** `subscriptions.ts:227` `getSubscriptionSummary`.
- **Event queue'da sonsuz retry:** `eventQueue.ts:60` başarısız yazımı kuyruk başına geri basıyor.
  Kalıcı bozuk payload kuyruğu tıkar. Retry sayacı + dead-letter gerekli.
- **Env doğrulaması yok:** `env.ts:9` ham `Number(...)`. `PORT=abc` → NaN, geç patlar. zod fail-fast schema.

## P1 — Frontend veri katmanı

- `lib/api.ts:11` `AbortSignal` kabul etmiyor. Sonuç: unmount'ta iptal yok, arama isteklerinde race
  (eski cevap yeniyi eziyor — `Overview.tsx:76`, `Members.tsx:200`), polling üst üste biniyor
  (`Overview.tsx:70`, `Entries.tsx:53`, `Devices.tsx:90`). Tek düzeltme (`signal` desteği + ortak
  `usePollingQuery` hook'u) beş ayrı bulguyu kapatıyor.
- `Settings.tsx:31` ilk yükleme hatası yakalanmıyor — kullanıcı sadece pasif buton görüyor.
- Tip kaçakları: `auth.ts:13` `unknown as SessionUser`, `Members.tsx:231` `role as ...` cast.

## P2 — Ürün boşlukları (kapsam içi)

Roadmap Faz 0–8 fiilen kapalı; tek açık madde KPI-2 (kayıt süresi ölçümü). Asıl boşluk operasyonel:

1. **Raporlama** — bugün sadece "aktif üye" + "7 günde yenileme" sayacı var (`admin.ts:426`).
   Tarih aralığı, yeni/kayıp üye, giriş trendi, abonelik bitiş dağılımı yok.
2. **Yenileme hatırlatmaları** — "Yenileme Bekleyen" tıklanamayan bir sayı. Üye listesi, personel
   aksiyonu, e-posta/push hatırlatma yok. Üye kaybına doğrudan etkili.
3. **Üye iletişimi** — SMTP yalnız OTP için. Duyuru/abonelik-bitiş mesajı yok.
4. **Veri dışa aktarma** — CSV/XLSX yok; muhasebe ve denetim manuel.
5. **Geçiş geçmişi araştırılabilir değil** — filtre yok, üye detayında geçmiş yok.
6. **KVKK taşınabilirlik** — silme var, "verilerimi indir" yok.

## P2 — Altyapı / DevOps

- **Production dağıtımı yarım:** `apps/api/Dockerfile` var ama compose yalnız Mongo+Redis.
  Web için image yok, reverse-proxy/TLS yok, `compose.prod.yml` yok. Self-hosted ürün için en büyük boşluk.
- **CI'da güvenlik kapısı yok:** lint/typecheck/test/build var; `pnpm audit`, CodeQL, image/secret scan yok.
- **Release/deploy otomasyonu yok.**
- **Gözlemlenebilirlik `console.error` seviyesinde** — structured logging, request-id, metrics, error tracking yok.
- **Backup/restore stratejisi yazılı değil** (volume var, prosedür yok).
- **Test:** coverage runner yok, E2E yok. Web/mobilde yalnızca i18n testleri mevcut;
  auth, rol gating, admin mutation, QR akışı testsiz. API'de kritik route'lar (initial-password,
  role+MFA, device CRUD, KVKK onay/ret) HTTP seviyesinde test edilmiyor.
- **Repo hijyeni:** kökte `spor-salonu-ye-dashboard/`, `sports-salon-dashboard-design/`,
  `login-visual.png` (1.2 MB), `sast/` — commit edilmemiş, `.dockerignore`'da da yok.

## P3 — Kalite / bakım

- `middleware.ts:82` `mustChangePassword` istisnaları string path listesi — yeni route yanlışlıkla açık kalabilir.
- `audit.ts:4` `action: string` serbest — typo compile-time'da yakalanmıyor, shared union olmalı.
- `App.tsx:122` (web) tüm route'lar eager import — `React.lazy` ile böl.
- `Login.tsx` (web) 400+ satır, dört akış tek state machine'de.
- Mobilde navigation library yok (`App.tsx:37`) — deep link, Android geri tuşu, ekran geçmişi yok.
- `app.json:31` Android kamera izni manifest listesinde yok; izin metinleri İngilizce.
- Erişilebilirlik: MFA modalında `role="dialog"`/focus trap yok (`Members.tsx:392`),
  arama inputlarında label yok.

---

## Önerilen sıra

1. **Operasyonel sağlamlık haftası** — P0/1–3 + graceful shutdown + zod env + prod compose.
   Bunlar olmadan gerçek bir salona kurulum riskli.
2. **Veri katmanı haftası** — pagination + index seti + `AbortSignal` (API ve web birlikte, tek sözleşme).
3. **Mobil dayanıklılık** — `try/finally` auth sarmalayıcı + config sertleştirme + navigation.
4. **Ürün değeri** — raporlama ve yenileme hatırlatmaları; salon sahibinin günlük kullandığı iki şey.
5. **CI sertleştirme + test kapsamı** — audit/CodeQL, coverage eşiği, kritik route HTTP testleri.

## Kapsam dışı — dokunulmayacak

Online ödeme, multi-tenant/çoklu şube, ders rezervasyonu/antrenman/diyet (PRD:103-105),
PRD Ek A path-obfuscation/custom cipher katmanı (PRD:176, ROADMAP:145 — arşivde kalır).
