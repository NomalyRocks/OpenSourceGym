# R2 profil fotoğrafı kurulumu

Üye profil fotoğrafları Cloudflare R2'de saklanır ve public custom domain
üzerinden okunur. Yüklemeler istemciden doğrudan R2'ye yapılmaz; API görseli
doğrulayıp normalize ettikten sonra bucket'a yazar.

## Cloudflare yapılandırması

1. Profil fotoğrafları için bir R2 bucket oluşturun.
2. Yalnızca bu bucket'ta object read/write yetkisi olan bir R2 API token üretin.
3. Bucket'a Cloudflare'da yönetilen bir custom domain bağlayın.
4. Production ortamında public `r2.dev` adresini kapalı tutun. Bucket listeleme
   public değildir; yalnızca tam nesne URL'sini bilenler görseli okuyabilir.
5. Aşağıdaki ortam değişkenlerini API'ye tanımlayın:

   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET_NAME`
   - `R2_PUBLIC_BASE_URL` (ör. `https://media.example.com`)

Production'da bu değerlerden biri eksikse API fail-fast davranışıyla başlamaz.
Development ortamında API çalışır; profil fotoğrafı uçları eksik yapılandırmayı
Türkçe `503` yanıtıyla bildirir.

## Saklama ve cache davranışı

- Nesne anahtarı ilk yüklemede rastgele üretilir ve sonraki değişikliklerde aynı
  anahtarın üzerine yazılır.
- Yanıt URL'sine güncelleme zamanı sürüm parametresi olarak eklenir.
- R2 nesnesi `Cache-Control: public, max-age=300` ile yazılır. Değiştirilen veya
  kaldırılan eski görsel CDN cache'inde en fazla beş dakika kalabilir.
- Hesap silme işlemi, R2 nesnesi silinmeden tamamlanmaz.

API server-side S3 uç noktasını kullandığı için bucket'ta istemci upload CORS
kuralı veya presigned PUT yapılandırması gerekmez.
