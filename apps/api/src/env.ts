import { z } from "zod";

const isProduction = process.env.NODE_ENV === "production";

/** Virgülle ayrılmış origin listesini temizleyip diziye çevirir. */
const originList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).nonempty());

const port = z.coerce.number().int().min(1).max(65535);

// Production'da zayıf varsayılanlar kabul edilmez: BETTER_AUTH_SECRET
// verilmemişse süreç açılışta düşmeli, sessizce dev anahtarına inmemeli.
const betterAuthSecret = isProduction
  ? z.string().min(32)
  : z.string().min(1).default("dev-only-secret-do-not-use-in-prod");

const envSchema = z.object({
  PORT: port.default(3000),
  NODE_ENV: z.string().default("development"),
  ENABLE_API_DOCS: z.string().optional(),
  MONGODB_URI: z.string().min(1).default("mongodb://localhost:27017/opengym"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  BETTER_AUTH_SECRET: betterAuthSecret,
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  // prefault (default değil): varsayılan da transform+doğrulamadan geçmeli,
  // aksi halde zod çıkış tarafında kısa devre yapıp ham string bırakır.
  TRUSTED_ORIGINS: originList.prefault("http://localhost:5173"),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.url().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: port.default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("OpenGym <noreply@opengym.local>"),
});

// Boş string "tanımsız" demektir. docker compose'daki `${VAR:-}` yazımı
// değişkeni BOŞ DEĞERLE gönderir, hiç göndermemiş olmaz; bunu ayıklamazsak
// isteğe bağlı bir URL alanı (ör. R2_PUBLIC_BASE_URL) boş geldiğinde şema
// hata verir ve R2 kullanmayan her kurulum açılışta crash-loop'a girer.
const presentEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== ""),
);

const parsed = envSchema.safeParse(presentEnv);

if (!parsed.success) {
  // Yapılandırma hatası çalışma anına ertelenmemeli: hangi değişkenin neden
  // reddedildiğini tek seferde yazıp süreci sonlandırıyoruz.
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(kök)"}: ${issue.message}`)
    .join("\n");
  console.error(`Geçersiz ortam yapılandırması:\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  port: raw.PORT,
  nodeEnv: raw.NODE_ENV,
  enableApiDocs: raw.ENABLE_API_DOCS === "true",
  mongodbUri: raw.MONGODB_URI,
  redisUrl: raw.REDIS_URL,
  betterAuthSecret: raw.BETTER_AUTH_SECRET,
  betterAuthUrl: raw.BETTER_AUTH_URL,
  trustedOrigins: raw.TRUSTED_ORIGINS,
  r2: {
    accountId: raw.R2_ACCOUNT_ID,
    accessKeyId: raw.R2_ACCESS_KEY_ID,
    secretAccessKey: raw.R2_SECRET_ACCESS_KEY,
    bucketName: raw.R2_BUCKET_NAME,
    publicBaseUrl: raw.R2_PUBLIC_BASE_URL,
  },
  smtp: {
    host: raw.SMTP_HOST,
    port: raw.SMTP_PORT,
    user: raw.SMTP_USER,
    pass: raw.SMTP_PASS,
    from: raw.SMTP_FROM,
  },
};
