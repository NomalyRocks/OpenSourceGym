# Kalori Aracı Kalamar Görseli ve Giriş Yerleşimi

## Amaç

Kalori hesaplayıcısının giriş ekranında başlığın küçük telefonlarda ilk görünümün
altına itilmesini önlemek ve mevcut yuvarlak 3B ahtapot görsellerini OpenGym'in
görsel diliyle daha uyumlu, özgün bir kalamar setiyle değiştirmek.

## Onaylanan Görsel Yön

- Seçilen yön **B — Dinamik Mürekkep**: belirgin lacivert mürekkep konturları,
  görünür fakat kontrollü kalem yapım çizgileri ve açılı low-poly yüzeyler.
- Karakter anatomisi yuvarlak başlı bir ahtapot değil; sivrilen gövde, yan yüzgeçler,
  kısa kollar ve iki uzun beslenme dokunacıyla açıkça kalamar olarak okunur.
- Palet OpenGym ültramarinleri (`#3957cc`, `#7899f8`), buz mavileri ve koyu
  mürekkep tonlarından oluşur. Açık temada silüetin kaybolmaması için orta/koyu
  mavi yüzeyler beyaz yüzeylerden daha fazla alan kaplar.
- Görseller metinsiz, logosuz, gölgesiz ve şeffaf arka planlı WebP olarak saklanır.

## İki Pozluk Set

1. **Giriş:** Kalamar elma, küçük dambıl ve tek kıvrımlı mezura taşır. Silüet
   kompakt kalır ve 176–228 px aralığında net okunur.
2. **Sonuç:** Aynı yüz, gövde oranı, çizgi dili ve palet korunur. Karakter kutlama
   pozundadır; protein/karbonhidrat/yağı temsil eden mevcut kırmızı altıgen, sarı
   daire ve mavi damla işaretlerini taşır.

## Küçük Ekran Yerleşimi

- Giriş görseli artık ekran genişliğinin yüzde 82'sine bağlı 320 px'e kadar büyüyen
  kare değildir. Pencere yüksekliği ve yazı ölçeğine göre kompakt veya standart
  boy seçilir.
- Yaklaşık 760 dp altındaki yüksekliklerde ya da büyütülmüş yazıda görsel
  176–188 px bandına iner; standart telefonlarda en fazla 228 px olur.
- Başlık, açıklama ve gizlilik notu görselden sonra ilk görünümde kalır. Mevcut
  `ScrollView`, yatay ekran ve çok büyük erişilebilirlik yazısı için emniyet olarak
  korunur; ana yerleşim kaydırmaya ihtiyaç duymaz.
- Başlık, buton, safe-area, geri eylemi ve azaltılmış hareket davranışı değişmez.

## Doğrulama

- Görseller şeffaf köşe, alfa kanalı, açık/koyu zemin kontrastı ve küçük boyutta
  silüet okunabilirliği açısından kontrol edilir.
- Mobil lint, tip kontrolü, testler ve Android Expo production export çalıştırılır.
- Giriş yerleşimi en az 360×720 sınıfı görünüm ve büyük yazı senaryosu için kod
  düzeyinde sınırlandırılır; KVM erişimi varsa emülatör ekran görüntüsüyle doğrulanır.
