import { z } from "zod";

const isProduction = process.env.NODE_ENV === "production";

/** Cleans a comma-separated origin list and converts it to an array. */
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

// A report "day" is the gym's local day, not the UTC day: if a 01:00 entry
// lands in yesterday's bucket, daily counts will not match what the gym owner
// sees. Intl throws RangeError for an invalid zone name; catch that at startup
// and return a clear error.
const timeZone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a valid IANA time zone (for example Europe/Istanbul)" },
);

// Weak defaults are not accepted in production: when BETTER_AUTH_SECRET is
// absent, the process must fail at startup instead of silently using the dev key.
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
  // prefault (not default): the fallback must also pass through transformation
  // and validation; otherwise Zod short-circuits on output and leaves a raw string.
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
  // prefault: the fallback must also pass through refine (see TRUSTED_ORIGINS).
  REPORTS_TIME_ZONE: timeZone.prefault("Europe/Istanbul"),
});

// An empty string means "undefined." Docker Compose syntax `${VAR:-}` passes
// the variable WITH AN EMPTY VALUE rather than omitting it; without filtering
// this out, an empty optional URL such as R2_PUBLIC_BASE_URL fails validation
// and every installation without R2 enters a startup crash loop.
const presentEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== ""),
);

const parsed = envSchema.safeParse(presentEnv);

if (!parsed.success) {
  // Configuration errors must not be deferred until runtime: print every
  // rejected variable and its reason at once, then terminate the process.
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${issues}`);
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
  reportsTimeZone: raw.REPORTS_TIME_ZONE,
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
