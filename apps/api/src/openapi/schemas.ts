import { z } from "zod";

const withId = <T extends z.ZodType>(schema: T, id: string): T =>
  schema.meta({ id }) as T;

export const pageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable().meta({
      description:
        "Sonraki sayfa için cursor sorgu parametresine verilir; son sayfada null olur",
    }),
  });

export const roleSchema = withId(z.enum(["admin", "staff", "member"]), "Role");

export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i)
  .meta({ description: "MongoDB ObjectId (24 onaltılık karakter)" });

export const isoDateTimeSchema = z.iso.datetime().meta({
  description: "ISO 8601 zaman damgası",
});

export const apiErrorSchema = withId(
  z.object({
    code: z.string(),
    message: z.string(),
  }),
  "ApiError",
);

export const okSchema = withId(z.object({ ok: z.literal(true) }), "Ok");

export const publicUserSchema = withId(
  z.object({
    id: objectIdSchema,
    name: z.string(),
    email: z.email(),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string(),
    role: roleSchema,
    emailVerified: z.boolean(),
    twoFactorEnabled: z.boolean(),
    profilePhotoUrl: z.url().nullable(),
    createdAt: isoDateTimeSchema,
  }),
  "PublicUser",
);

export const myProfileSchema = withId(
  z.object({
    id: objectIdSchema,
    email: z.email(),
    name: z.string(),
    role: roleSchema,
    mustChangePassword: z.boolean(),
    twoFactorEnabled: z.boolean(),
    profilePhotoUrl: z.url().nullable(),
  }),
  "MyProfile",
);

export const subscriptionSchema = withId(
  z.object({
    id: objectIdSchema,
    userId: objectIdSchema,
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    note: z.string().optional(),
    createdBy: z.string(),
    createdAt: isoDateTimeSchema,
  }),
  "Subscription",
);

export const sharingConfigSchema = withId(
  z.object({
    memberMaxSessions: z.number().int().min(1).max(10),
    staffMaxSessions: z.number().int().min(1).max(20),
    signalThreshold: z.number().int().min(1).max(20),
    signalWindowHours: z.number().int().min(1).max(168),
    qrBlockHours: z.number().int().min(1).max(168),
  }),
  "SharingConfig",
);

export const locationSchema = withId(
  z.object({
    lat: z.number().finite(),
    lng: z.number().finite(),
    radiusM: z.number().finite().positive(),
  }),
  "GymLocation",
);

export const gymSettingsSchema = withId(
  z.object({
    gymName: z.string(),
    location: locationSchema.nullable(),
    capacity: z.number().positive().nullable(),
    autoExitHours: z.number().int().min(1).max(48),
    sharing: sharingConfigSchema,
  }),
  "GymSettings",
);

export const adminStatsSchema = withId(
  z.object({
    activeMembers: z.number().int().nonnegative(),
    renewalsDue: z.number().int().nonnegative(),
  }),
  "AdminStats",
);

export const auditLogSchema = withId(
  z.object({
    id: objectIdSchema,
    actorId: z.string(),
    actorEmail: z.string().nullable(),
    action: z.string(),
    targetId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    at: isoDateTimeSchema,
  }),
  "AuditLogEntry",
);

export const gateRejectCodeSchema = withId(
  z.enum([
    "INVALID_QR",
    "UNKNOWN_DEVICE",
    "DEVICE_OFFLINE",
    "NO_ACTIVE_SUBSCRIPTION",
    "LOCATION_REQUIRED",
    "OUT_OF_RANGE",
    "MOCK_LOCATION",
    "SHARING_BLOCKED",
  ]),
  "GateRejectCode",
);

export const entryEventSchema = withId(
  z.object({
    id: objectIdSchema,
    deviceId: z.string(),
    deviceName: z.string(),
    userId: z.string().nullable(),
    memberName: z.string().nullable(),
    allowed: z.boolean(),
    reason: gateRejectCodeSchema.nullable(),
    at: isoDateTimeSchema,
  }),
  "EntryEvent",
);

export const deletionRequestSchema = withId(
  z.object({
    id: objectIdSchema,
    userId: objectIdSchema,
    email: z.string(),
    name: z.string(),
    requestedAt: isoDateTimeSchema,
    status: z.enum(["pending", "approved", "rejected"]),
    resolvedAt: isoDateTimeSchema.nullable(),
    resolvedBy: z.string().nullable(),
  }),
  "DeletionRequest",
);

export const deviceDirectionSchema = withId(
  z.enum(["in", "out"]),
  "DeviceDirection",
);

export const deviceSchema = withId(
  z.object({
    id: objectIdSchema,
    name: z.string(),
    direction: deviceDirectionSchema,
    online: z.boolean(),
    lastSeenAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    uptime24h: z.number().min(0).max(100),
    qrContent: z.string(),
  }),
  "Device",
);

export const deviceCreatedSchema = withId(
  z.object({
    id: objectIdSchema,
    name: z.string(),
    direction: deviceDirectionSchema,
    token: z.string(),
    qrContent: z.string(),
  }),
  "DeviceCreated",
);

export const profilePhotoResponseSchema = withId(
  z.object({ profilePhotoUrl: z.url().nullable() }),
  "ProfilePhotoResponse",
);

export const mySubscriptionSchema = withId(
  z.object({
    active: z.boolean(),
    startsAt: isoDateTimeSchema.nullable(),
    endsAt: isoDateTimeSchema.nullable(),
    remainingDays: z.number().int().nonnegative(),
  }),
  "MySubscription",
);

export const myEntriesSchema = withId(
  z.object({
    days: z.array(
      z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .meta({
            description: "Salon saat dilimindeki takvim günü",
          }),
        entries: z.number().int().positive(),
      }),
    ),
    timeZone: z.string().meta({
      description: "Günlerin hesaplandığı IANA saat dilimi",
    }),
  }),
  "MyEntries",
);

export const gateScanResponseSchema = withId(
  z.object({
    ok: z.literal(true),
    deviceName: z.string(),
    direction: deviceDirectionSchema,
    openMs: z.number().int().positive(),
  }),
  "GateScanResponse",
);

export const occupancySchema = withId(
  z.object({
    inside: z.number().int().nonnegative(),
    capacity: z.number().positive().nullable(),
    ratio: z.number().nonnegative().nullable(),
  }),
  "Occupancy",
);

export const myDeletionRequestSchema = withId(
  z.object({
    status: z.enum(["none", "pending", "rejected"]),
    requestedAt: isoDateTimeSchema.nullable(),
  }),
  "MyDeletionRequest",
);

export const healthSchema = withId(
  z.object({
    status: z.literal("ok"),
    service: z.string(),
    timestamp: isoDateTimeSchema,
  }),
  "Health",
);

export const authUserSchema = withId(
  z.object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    emailVerified: z.boolean(),
    image: z.url().nullable().optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string(),
    role: roleSchema,
    mustChangePassword: z.boolean(),
    twoFactorEnabled: z.boolean().optional(),
    kvkkAccepted: z.boolean(),
    privacyAccepted: z.boolean(),
    kvkkAcceptedAt: isoDateTimeSchema.nullable().optional(),
    privacyAcceptedAt: isoDateTimeSchema.nullable().optional(),
  }),
  "AuthUser",
);

export const authSessionSchema = withId(
  z.object({
    id: z.string(),
    userId: z.string(),
    token: z.string(),
    expiresAt: isoDateTimeSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    ipAddress: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
    deviceFingerprint: z.string().optional(),
  }),
  "AuthSession",
);

export const authErrorSchema = withId(
  z.object({
    code: z.string().optional(),
    message: z.string(),
  }),
  "AuthError",
);

// İstek şemaları routes/*.ts içindeki dosyaya özel zod doğrulayıcılarını yansıtır.
export const initialPasswordRequestSchema = withId(
  z.object({
    currentPassword: z.string(),
    newPassword: z.string().min(8),
  }),
  "InitialPasswordRequest",
);

export const roleRequestSchema = withId(
  z.object({
    role: roleSchema,
    mfaCode: z.string().min(1).optional(),
    mfaMethod: z.enum(["totp", "otp"]).optional(),
  }),
  "RoleRequest",
);

export const createSubscriptionRequestSchema = withId(
  z
    .object({
      userId: z.string(),
      months: z.union([
        z.literal(1),
        z.literal(3),
        z.literal(6),
        z.literal(12),
      ]),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
  "CreateSubscriptionRequest",
);

const numericFormValue = z.union([z.number(), z.string()]).meta({
  description:
    "A number, or a numeric form string accepted by z.coerce.number()",
});

export const gymSettingsRequestSchema = withId(
  z.object({
    gymName: z.string().trim().min(1),
    location: z
      .object({
        lat: numericFormValue,
        lng: numericFormValue,
        radiusM: numericFormValue,
      })
      .nullish(),
    capacity: numericFormValue.nullish(),
    autoExitHours: numericFormValue.nullish(),
    sharing: sharingConfigSchema.optional(),
  }),
  "GymSettingsRequest",
);

export const createDeviceRequestSchema = withId(
  z.object({
    name: z.string().trim().min(1).max(100),
    direction: deviceDirectionSchema.default("in"),
  }),
  "CreateDeviceRequest",
);

export const gateScanRequestSchema = withId(
  z.object({
    qr: z.string().min(1).max(200),
    lat: z.number().optional(),
    lng: z.number().optional(),
    mocked: z.boolean().optional(),
  }),
  "GateScanRequest",
);

export const signUpRequestSchema = withId(
  z.object({
    name: z.string(),
    email: z.email(),
    password: z.string().min(8),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string(),
    kvkkAccepted: z.literal(true),
    privacyAccepted: z.literal(true),
    callbackURL: z.string().optional(),
    rememberMe: z.boolean().optional(),
  }),
  "SignUpRequest",
);

export const signInRequestSchema = withId(
  z.object({
    email: z.email(),
    password: z.string(),
    callbackURL: z.string().optional(),
    rememberMe: z.boolean().default(true).optional(),
  }),
  "SignInRequest",
);

export const sendOtpRequestSchema = withId(
  z.object({
    email: z.email(),
    type: z.enum([
      "email-verification",
      "sign-in",
      "forget-password",
      "change-email",
    ]),
  }),
  "SendOtpRequest",
);

export const verifyEmailOtpRequestSchema = withId(
  z.object({
    email: z.email(),
    otp: z.string().length(6),
  }),
  "VerifyEmailOtpRequest",
);

export const signUpResponseSchema = withId(
  z.object({
    token: z.string().nullable().optional(),
    user: authUserSchema,
  }),
  "SignUpResponse",
);

export const signInResponseSchema = withId(
  z.object({
    redirect: z.boolean(),
    token: z.string(),
    url: z.string().nullable().optional(),
    user: authUserSchema,
  }),
  "SignInResponse",
);

export const otpSuccessSchema = withId(
  z.object({ success: z.literal(true) }),
  "OtpSuccess",
);

export const verifyEmailOtpResponseSchema = withId(
  z.object({
    status: z.literal(true),
    token: z.string().nullable(),
    user: authUserSchema,
  }),
  "VerifyEmailOtpResponse",
);

export const getSessionResponseSchema = withId(
  z
    .object({
      session: authSessionSchema,
      user: authUserSchema,
    })
    .nullable(),
  "GetSessionResponse",
);

export const createSubscriptionResponseSchema = withId(
  z.object({
    ok: z.literal(true),
    id: objectIdSchema,
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
  }),
  "CreateSubscriptionResponse",
);
