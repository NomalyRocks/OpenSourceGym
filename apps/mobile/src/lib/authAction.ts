/**
 * Kimlik doğrulama ekranlarındaki "gönder" akışlarının ortak iskeleti.
 *
 * BetterAuth istemcisi API hatalarını `{ error }` olarak DÖNDÜRÜR, ancak ağ/TLS
 * katmanındaki bir sorun istisna FIRLATIR. Ekranlar yalnızca `{ error }` yolunu
 * ele aldığı için, bağlantı koptuğunda `setBusy(false)` satırına hiç
 * ulaşılmıyordu: buton sonsuza kadar yükleniyor durumunda kalıyor ve kullanıcı
 * ekranı kapatmadan tekrar deneyemiyordu.
 *
 * Burada busy bayrağı `finally` ile her koşulda geri alınır ve yakalanan
 * istisna kullanıcıya gösterilebilir bir mesaja çevrilir.
 */
export async function runAuthAction(
  setBusy: (value: boolean) => void,
  onUnreachable: () => void,
  action: () => Promise<void>,
): Promise<void> {
  setBusy(true);
  try {
    await action();
  } catch (err) {
    // Tüm istisnalar "bağlantı kurulamadı" olarak gösterilir; gerçek sebebi
    // gizlememek için geliştirici konsoluna yazılır.
    console.error("kimlik doğrulama isteği başarısız:", err);
    onUnreachable();
  } finally {
    setBusy(false);
  }
}
