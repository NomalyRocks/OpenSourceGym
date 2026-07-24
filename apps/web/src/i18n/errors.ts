import type { TFunction } from "i18next";
import type { ApiErrorCode } from "@opengym/shared";
import { ApiError } from "../lib/api";
import type { WebTranslationKey } from "./resources";

const codeMessages: Record<ApiErrorCode, WebTranslationKey> = {
  AUTH_REQUIRED: "Oturum gerekli.",
  FORBIDDEN: "Bu işlem için yetkiniz yok.",
  INTERNAL_ERROR: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.",
  INVALID_PHONE_NUMBER: "Geçerli bir telefon numarası girin.",
  PHONE_ALREADY_EXISTS: "Bu telefon numarası zaten kullanımda.",
  PASSWORD_CHANGE_REQUIRED: "Devam etmeden önce şifrenizi değiştirmelisiniz.",
  PAYLOAD_TOO_LARGE: "Fotoğraf en fazla 10 MB olabilir.",
  PROFILE_PHOTO_MISSING: "Fotoğraf verisi gönderilmedi.",
  PROFILE_PHOTO_INVALID: "Seçilen dosya geçerli bir fotoğraf değil.",
  PROFILE_PHOTO_BUSY: "Fotoğraf işlemi sürüyor. Lütfen tekrar deneyin.",
  PROFILE_PHOTO_RATE_LIMITED:
    "Çok fazla fotoğraf işlemi yaptınız. Lütfen biraz bekleyin.",
  PROFILE_PHOTO_UNAVAILABLE: "Profil fotoğrafı hizmeti şu anda kullanılamıyor.",
  INVALID_REQUEST: "Geçersiz istek.",
  RATE_LIMITED: "Çok fazla istek. Lütfen biraz bekleyin.",
  INVALID_QR: "Geçersiz QR kodu. Turnikedeki kodu tekrar okutun.",
  SHARING_BLOCKED:
    "Hesabınızda olağan dışı kullanım tespit edildi. Geçiş geçici olarak kapatıldı. Lütfen resepsiyona başvurun.",
  MOCK_LOCATION:
    "Sahte konum tespit edildi. Gerçek konumunuzu kullanarak tekrar deneyin.",
  UNKNOWN_DEVICE: "Bu turnike artık kayıtlı değil. Resepsiyona başvurun.",
  NO_ACTIVE_SUBSCRIPTION:
    "Aktif aboneliğiniz yok. Salon resepsiyonuna başvurun.",
  LOCATION_REQUIRED: "Konumunuz alınamadı. Konum izni verip tekrar deneyin.",
  OUT_OF_RANGE:
    "Salon konumunda görünmüyorsunuz. Geçiş yalnızca salonda yapılabilir.",
  DEVICE_OFFLINE: "Turnike bağlantısı yok. Lütfen resepsiyona başvurun.",
  DELETION_MEMBER_ONLY: "Yalnızca üye hesapları silme talebi oluşturabilir.",
  DELETION_ALREADY_PENDING: "Zaten bekleyen bir silme talebiniz var.",
  DELETION_NOT_PENDING: "Bekleyen bir silme talebi bulunamadı.",
  INVALID_DEVICE_NAME: "Geçerli bir cihaz adı girin.",
  DEVICE_NOT_FOUND: "Cihaz bulunamadı.",
  PASSWORD_TOO_SHORT: "Yeni şifre en az 8 karakter olmalı.",
  CURRENT_PASSWORD_INVALID: "Şifre hatalı.",
  SEARCH_QUERY_TOO_SHORT: "Aramak için en az iki karakter girin.",
  INVALID_USER_OR_ROLE: "Geçersiz kullanıcı veya rol.",
  SELF_ROLE_CHANGE: "Kendi rolünüzü değiştiremezsiniz.",
  MFA_REQUIRED: "Bu işlem için MFA doğrulaması gerekli.",
  MFA_LOCKED: "Çok fazla doğrulama denemesi. Lütfen daha sonra tekrar deneyin.",
  MFA_INVALID: "Doğrulama kodu geçersiz veya süresi dolmuş.",
  USER_NOT_FOUND: "Kullanıcı bulunamadı.",
  INVALID_SUBSCRIPTION: "Geçerli kullanıcı ve abonelik paketi girin.",
  SUBSCRIPTION_BUSY: "Abonelik işlemi sürüyor. Lütfen tekrar deneyin.",
  INVALID_USER: "Geçersiz kullanıcı.",
  GYM_NAME_REQUIRED: "Salon adı zorunludur.",
  INVALID_LOCATION: "Geçersiz konum bilgisi.",
  INVALID_CAPACITY: "Geçersiz kapasite.",
  INVALID_AUTO_EXIT: "Geçersiz otomatik çıkış süresi.",
  INVALID_SHARING_SETTINGS: "Geçersiz paylaşım tespiti ayarları.",
  DELETION_REQUEST_NOT_FOUND: "Silme talebi bulunamadı.",
  DELETION_REQUEST_RESOLVED: "Silme talebi zaten sonuçlandırılmış.",
  DELETION_CLEANUP_FAILED:
    "Hesap verileri temizlenemedi. Lütfen tekrar deneyin.",
};

export function errorMessage(
  error: unknown,
  t: TFunction,
  fallback: WebTranslationKey,
): string {
  if (error instanceof ApiError && error.code) {
    const key = codeMessages[error.code as ApiErrorCode];
    if (key) return t(key);
  }
  return t(fallback);
}
