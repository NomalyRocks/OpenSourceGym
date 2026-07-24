import type { TFunction } from "i18next";
import type { ApiErrorCode } from "@opengym/shared";
import { ApiError } from "../lib/api";
import type { MobileTranslationKey } from "./resources";

const codeMessages = {
  AUTH_REQUIRED: "Oturum gerekli.",
  FORBIDDEN: "Bu işlem için yetkiniz yok.",
  INTERNAL_ERROR: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.",
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
  LOCAL_FILE_READ_FAILED: "Seçilen fotoğraf okunamadı.",
  DELETION_MEMBER_ONLY: "Yalnızca üye hesapları silme talebi oluşturabilir.",
  DELETION_ALREADY_PENDING: "Zaten bekleyen bir silme talebiniz var.",
  DELETION_NOT_PENDING: "Bekleyen bir silme talebi bulunamadı.",
  INVALID_PHONE_NUMBER: "Geçerli bir telefon numarası girin.",
  PHONE_ALREADY_EXISTS: "Bu telefon numarası ile kayıtlı hesap var.",
} satisfies Partial<
  Record<ApiErrorCode | "LOCAL_FILE_READ_FAILED", MobileTranslationKey>
>;

export function errorMessage(
  error: unknown,
  t: TFunction,
  fallback: MobileTranslationKey,
): string {
  if (error instanceof ApiError && error.code) {
    const key = codeMessages[error.code as keyof typeof codeMessages];
    if (key) return t(key);
  }
  return t(fallback);
}
