# OpenGym Günlük Kalori ve Makro Aracı Tasarımı

## Özet

Mobil uygulamaya beşinci `Araçlar` hedefi ve tamamen cihazda çalışan bir günlük
kalori/makro hesaplayıcısı eklenir. Yazio referansından tek soru, üst ilerleme ve
sabit alt eylem ritmi alınır; OpenGym teması ve özgün kalamar maskotu korunur.

## Deneyim

- Araçlar gridinde ilk sürümde yalnız çalışan günlük kalori kartı görünür.
- Kart; giriş, cinsiyet, yaş, boy, kilo, hareket, hedef ve sonuç ekranlarını tam
  ekran açar. Alt menü gizlenir; görsel ve sistem geri eylemleri önceki adıma döner.
- Giriş ve sonuçta iki özgün kalamar illüstrasyonu yer alır. Veri adımları odaklı
  ve illüstrasyonsuzdur; açık/koyu tema ile TR/EN birlikte desteklenir.
- Girdiler yalnız açık akışta tutulur ve çıkışta silinir.

## Hesaplama

- Mifflin–St Jeor BMR; hareket çarpanları `1.2 / 1.375 / 1.55 / 1.725 / 1.9`.
- Hedef faktörleri: yağ kaybı `0.85`, koruma `1`, kas kazanımı `1.10`.
- Makrolar protein/karbonhidrat/yağ sırasıyla yağ kaybında `30/45/25`,
  korumada `25/45/30`, kas kazanımında `25/50/25` yüzdeleridir.
- Yaş `18–80`, boy `120–230 cm`, kilo `35–300 kg`; kalori en yakın 10'a,
  makrolar tam grama yuvarlanır.

## Kalite

Hesaplama ve birim dönüşümleri saf TypeScript testleriyle korunur. Akış 48 dp
dokunma hedefi, ekran okuyucu rolleri, büyük yazı, safe area, klavye ve azaltılmış
hareket gereksinimlerini karşılar. Backend ve ortak paketler değişmez.
