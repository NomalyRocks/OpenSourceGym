function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  enableApiDocs: process.env.ENABLE_API_DOCS === "true",
  mongodbUri: required("MONGODB_URI", "mongodb://localhost:27017/opengym"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  betterAuthSecret: required(
    "BETTER_AUTH_SECRET",
    process.env.NODE_ENV === "production"
      ? undefined
      : "dev-only-secret-do-not-use-in-prod",
  ),
  betterAuthUrl: required("BETTER_AUTH_URL", "http://localhost:3000"),
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME,
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM ?? "OpenGym <noreply@opengym.local>",
  },
};
