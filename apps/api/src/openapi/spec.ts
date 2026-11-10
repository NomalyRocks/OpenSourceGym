import { z } from "zod";
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiRequestBodyObject,
  type ZodOpenApiResponseObject,
} from "zod-openapi";
import {
  acceptInviteSchema,
  createInviteSchema,
  lookupInviteSchema,
} from "../features/invites/schemas.js";
import { userDirectoryQuerySchema } from "../features/members/userDirectory.js";
import {
  memberInviteSchema,
  inviteLookupResponseSchema,
  adminStatsSchema,
  apiErrorSchema,
  auditLogSchema,
  authErrorSchema,
  createDeviceRequestSchema,
  createSubscriptionRequestSchema,
  setSubscriptionGymsRequestSchema,
  createSubscriptionResponseSchema,
  cashReportSchema,
  createPackageRequestSchema,
  debtorRowSchema,
  packageSchema,
  packageListResponseSchema,
  paymentResultSchema,
  paymentSchema,
  recordPaymentRequestSchema,
  updatePackageRequestSchema,
  updateSubscriptionSaleRequestSchema,
  voidPaymentRequestSchema,
  cancelSubscriptionResponseSchema,
  banMemberRequestSchema,
  createMemberDeletionRequestSchema,
  memberDetailSchema,
  deletionRequestSchema,
  deviceCreatedSchema,
  deviceSchema,
  entryEventSchema,
  gateScanRequestSchema,
  gateOpenRequestSchema,
  gateDeviceSummarySchema,
  gateScanResponseSchema,
  getSessionResponseSchema,
  chainSettingsRequestSchema,
  chainSettingsSchema,
  createGymRequestSchema,
  gymSchema,
  gymSettingsRequestSchema,
  myOccupancySchema,
  occupancySchema,
  gymInsideSchema,
  setUserGymsRequestSchema,
  updateGymRequestSchema,
  healthSchema,
  initialPasswordRequestSchema,
  legalConfigSchema,
  myDeletionRequestSchema,
  myEntriesSchema,
  myPresenceSchema,
  myBusyHoursSchema,
  myBodyMetricsSchema,
  myBodyMetricsUpdateSchema,
  myProfileSchema,
  myWeightHistorySchema,
  mySubscriptionSchema,
  objectIdSchema,
  okSchema,
  otpSuccessSchema,
  pageSchema,
  profilePhotoResponseSchema,
  publicUserSchema,
  roleRequestSchema,
  sendOtpRequestSchema,
  signInRequestSchema,
  signInResponseSchema,
  signUpRequestSchema,
  signUpResponseSchema,
  subscriptionSchema,
  userDirectoryPageSchema,
  verifyEmailOtpRequestSchema,
  verifyEmailOtpResponseSchema,
} from "./schemas.js";

const jsonResponse = (
  description: string,
  schema: z.ZodType,
): ZodOpenApiResponseObject => ({
  description,
  content: { "application/json": { schema } },
});

const jsonBody = (schema: z.ZodType): ZodOpenApiRequestBodyObject => ({
  required: true,
  content: { "application/json": { schema } },
});

const authErrorResponse = jsonResponse("Authentication error", authErrorSchema);
const apiErrorResponse = jsonResponse("OpenGym API error", apiErrorSchema);

const protectedResponses = (
  success: Record<string, ZodOpenApiResponseObject>,
): Record<string, ZodOpenApiResponseObject> => ({
  ...success,
  "401": jsonResponse("No valid session found", apiErrorSchema),
  "403": jsonResponse(
    "Blocked by role or mandatory password change",
    apiErrorSchema,
  ),
});

const requiredRole = (
  role: string,
  description: string,
  secured = true,
): Pick<ZodOpenApiOperationObject, "description" | "security"> => ({
  description: `${description}\n\nRequired role: ${role}.`,
  ...(secured ? { security: [{ sessionCookie: [] }] } : { security: [] }),
});

const gymPathParams = z.object({
  gymId: objectIdSchema.meta({ description: "MongoDB ObjectId of the gym" }),
});

const gymIdPathParams = gymPathParams;

const idPathParams = z.object({
  id: objectIdSchema.meta({
    description: "MongoDB ObjectId of the target record",
  }),
});

const userSearchQuery = z.object({
  q: z.string().trim().min(2).meta({
    description:
      "Phone, email, first name, or last name; at least 2 characters",
  }),
});

const dayLabelQuerySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .meta({ description: "Calendar day in the gym time zone (YYYY-MM-DD)" });

const myEntriesQuery = z.object({
  from: dayLabelQuerySchema,
  to: dayLabelQuerySchema.meta({
    description: "Last day of the range; at most 92 days after from",
  }),
});

const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional().meta({
    description: "Opaque continuation cursor returned by the previous page",
  }),
  limit: z.coerce.number().int().min(1).max(100).default(50).meta({
    description: "Records per page (default 50; 1-100)",
  }),
});

const auditQuerySchema = pageQuerySchema.extend({
  gymId: z.string().min(1).max(64).optional().meta({
    description: "Chain audit only: limits records to one gym",
  }),
  action: z.string().min(1).max(64).optional().meta({
    description: "Action name to filter by exact match (1-64 characters)",
  }),
  from: z.coerce
    .date()
    .optional()
    .meta({
      description: "Inclusive start date and time for the record timestamp",
      override: { type: "string", format: "date-time" },
    }),
  to: z.coerce
    .date()
    .optional()
    .meta({
      description: "Inclusive end date and time for the record timestamp",
      override: { type: "string", format: "date-time" },
    }),
});

const entryEventQuerySchema = pageQuerySchema.extend({
  source: z.enum(["qr", "reception"]).optional(),
  deviceId: z.string().min(1).max(64).optional().meta({
    description: "Device id to filter by (1-64 characters)",
  }),
  userId: z.string().min(1).max(64).optional().meta({
    description: "User id to filter by (1-64 characters)",
  }),
  allowed: z.enum(["true", "false"]).optional().meta({
    description: "Limits gate results to allowed or denied events",
  }),
  from: z.coerce
    .date()
    .optional()
    .meta({
      description: "Inclusive start date and time for the gate event",
      override: { type: "string", format: "date-time" },
    }),
  to: z.coerce
    .date()
    .optional()
    .meta({
      description: "Inclusive end date and time for the gate event",
      override: { type: "string", format: "date-time" },
    }),
});

const deletionRequestQuerySchema = pageQuerySchema.extend({
  status: z.enum(["pending", "approved", "rejected"]).optional().meta({
    description: "Filters requests by status",
  }),
});

const getSessionQuery = z.object({
  disableCookieCache: z.coerce.boolean().optional(),
  disableRefresh: z.coerce.boolean().optional(),
});

const binaryImageSchema = z.string().meta({
  description: "Up to 10 MB of JPEG, PNG, or WebP image data",
  override: { type: "string", format: "binary" },
});

export type OpenApiDocument = ReturnType<typeof createDocument>;

export const openApiDocument: OpenApiDocument = createDocument({
  openapi: "3.1.0",
  info: {
    title: "OpenGym REST API",
    version: "0.1.0",
    description:
      "REST surface for the OpenGym admin panel, member app, and gate device management. " +
      "BetterAuth owns the `/api/auth/*` paths; representative client endpoints for the active configuration are documented here.",
  },
  servers: [{ url: "/", description: "This OpenGym server" }],
  tags: [
    { name: "admin", description: "Staff and administrator operations" },
    { name: "me", description: "Operations for the signed-in user" },
    { name: "devices", description: "Gate device management" },
    { name: "system", description: "Health and API documentation" },
    {
      name: "auth",
      description: "Authentication endpoints provided by BetterAuth",
    },
  ],
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "better-auth.session_token",
        description:
          "BetterAuth-signed session cookie. In an HTTPS production deployment, BetterAuth may add the `__Secure-` prefix to the name.",
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["system"],
        operationId: "getHealth",
        summary: "Service health status",
        ...requiredRole(
          "none",
          "Reports that the API process is running",
          false,
        ),
        responses: { "200": jsonResponse("Service is healthy", healthSchema) },
      },
    },
    "/api/openapi.json": {
      get: {
        tags: ["system"],
        operationId: "getOpenApiDocument",
        summary: "Raw OpenAPI document",
        ...requiredRole(
          "none",
          "Returns the OpenAPI 3.1 document as JSON; development only, never served in production",
          false,
        ),
        responses: {
          "200": {
            description: "OpenAPI 3.1 JSON document",
            content: {
              "application/json": {
                schema: z.looseObject({
                  openapi: z.literal("3.1.0"),
                  info: z.object({
                    title: z.string(),
                    version: z.string(),
                  }),
                  paths: z.record(z.string(), z.unknown()),
                }),
              },
            },
          },
        },
      },
    },
    "/api/docs": {
      get: {
        tags: ["system"],
        operationId: "getSwaggerUi",
        summary: "Swagger UI",
        ...requiredRole(
          "none",
          "Opens Swagger UI using this document; development only, never served in production",
          false,
        ),
        responses: {
          "200": {
            description: "Swagger UI HTML page",
            content: {
              "text/html": {
                schema: z.string(),
              },
            },
          },
          "301": {
            description: "Redirect to the UI path with a trailing slash",
          },
        },
      },
    },
    "/api/invites/lookup": {
      post: {
        tags: ["admin"],
        operationId: "lookupMemberInvite",
        summary: "Look up an unexpired member invitation",
        description:
          "Public. Shares a 20 requests / 10 minutes per-IP limit with acceptance. Unknown and expired tokens return identical INVITE_INVALID responses. Responses must not be cached.",
        security: [],
        requestBody: jsonBody(lookupInviteSchema),
        responses: {
          "200": jsonResponse(
            "Invitation and current legal documents",
            inviteLookupResponseSchema,
          ),
          "404": jsonResponse("INVITE_INVALID", apiErrorSchema),
          "429": apiErrorResponse,
        },
      },
    },
    "/api/invites/accept": {
      post: {
        tags: ["admin"],
        operationId: "acceptMemberInvite",
        summary: "Accept a one-time invitation and create a verified member",
        description:
          "Public, IP-limited. Requires both personal consents, the current legal version and an 8–128 character password. Creates the account through BetterAuth, verifies email without OTP, deletes the invite and creates no session. The member signs in on mobile. Concurrent or reused tokens fail.",
        security: [],
        requestBody: jsonBody(acceptInviteSchema),
        responses: {
          "200": jsonResponse("Account ready; no session", okSchema),
          "400": jsonResponse(
            "Invalid consent/password or PHONE_ALREADY_EXISTS",
            apiErrorSchema,
          ),
          "404": jsonResponse("INVITE_INVALID", apiErrorSchema),
          "409": jsonResponse(
            "LEGAL_VERSION_CHANGED or EMAIL_TAKEN",
            apiErrorSchema,
          ),
          "429": apiErrorResponse,
        },
      },
    },
    "/api/admin/gyms/{gymId}/invites": {
      get: {
        tags: ["admin"],
        operationId: "listMemberInvites",
        summary: "List pending invites for this gym",
        ...requiredRole(
          "owner, admin, staff",
          "Only unexpired invites within the caller's gym scope are returned.",
        ),
        requestParams: { path: gymPathParams },
        responses: protectedResponses({
          "200": jsonResponse(
            "Pending invitations",
            z.array(memberInviteSchema),
          ),
          "404": apiErrorResponse,
        }),
      },
      post: {
        tags: ["admin"],
        operationId: "createMemberInvite",
        summary: "Invite a member by email",
        ...requiredRole(
          "owner, admin, staff",
          "Creates no account or consent. The link expires in seven days; only its SHA-256 hash is stored. Limit: 20 creation requests per actor per hour. The email uses PUBLIC_WEB_URL/invite#token=... .",
        ),
        requestParams: { path: gymPathParams },
        requestBody: jsonBody(createInviteSchema),
        responses: protectedResponses({
          "201": jsonResponse("Invitation emailed", memberInviteSchema),
          "400": jsonResponse(
            "Invalid input or PHONE_ALREADY_EXISTS",
            apiErrorSchema,
          ),
          "404": apiErrorResponse,
          "409": jsonResponse("EMAIL_TAKEN or INVITE_EXISTS", apiErrorSchema),
          "429": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}/invites/{id}/resend": {
      post: {
        tags: ["admin"],
        operationId: "resendMemberInvite",
        summary: "Rotate and resend an invitation",
        ...requiredRole(
          "owner, admin, staff",
          "Invalidates the old link and resets expiry to seven days. Maximum five resends; at least 60 seconds between sends.",
        ),
        requestParams: { path: gymPathParams.extend({ id: objectIdSchema }) },
        responses: protectedResponses({
          "200": jsonResponse("Invitation resent", memberInviteSchema),
          "404": jsonResponse(
            "INVITE_INVALID, including an invite belonging to another gym",
            apiErrorSchema,
          ),
          "409": jsonResponse("INVITE_RESEND_LIMIT", apiErrorSchema),
          "429": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}/invites/{id}": {
      delete: {
        tags: ["admin"],
        operationId: "cancelMemberInvite",
        summary: "Cancel and delete an invitation",
        ...requiredRole(
          "owner, admin, staff",
          "Deletes the pending invite and invalidates its email link. Audit records contain no invite contact information.",
        ),
        requestParams: { path: gymPathParams.extend({ id: objectIdSchema }) },
        responses: protectedResponses({
          "200": jsonResponse("Invitation cancelled", okSchema),
          "404": jsonResponse(
            "INVITE_INVALID, including an invite belonging to another gym",
            apiErrorSchema,
          ),
          "429": apiErrorResponse,
        }),
      },
    },
    "/api/legal": {
      get: {
        tags: ["system"],
        operationId: "getLegalConfig",
        summary: "Published legal document URLs",
        ...requiredRole(
          "none",
          "Returns the data-processing and privacy document URLs opened by the signup screen",
          false,
        ),
        responses: {
          "200": jsonResponse(
            "Legal document configuration",
            legalConfigSchema,
          ),
        },
      },
    },
    "/api/auth/sign-up/email": {
      post: {
        tags: ["auth"],
        operationId: "signUpEmail",
        summary: "Sign up with email and password",
        ...requiredRole(
          "none",
          "Creates a member account through BetterAuth; data-processing and privacy consent are required",
          false,
        ),
        requestBody: jsonBody(signUpRequestSchema),
        responses: {
          "200": jsonResponse("User created", signUpResponseSchema),
          "400": authErrorResponse,
          "422": authErrorResponse,
          "429": authErrorResponse,
        },
      },
    },
    "/api/auth/sign-in/email": {
      post: {
        tags: ["auth"],
        operationId: "signInEmail",
        summary: "Sign in with email and password",
        ...requiredRole(
          "none",
          "BetterAuth creates a session and writes the session cookie",
          false,
        ),
        requestBody: jsonBody(signInRequestSchema),
        responses: {
          "200": jsonResponse("Session created", signInResponseSchema),
          "401": authErrorResponse,
          "403": authErrorResponse,
          "429": authErrorResponse,
        },
      },
    },
    "/api/auth/sign-out": {
      post: {
        tags: ["auth"],
        operationId: "signOut",
        summary: "Sign out",
        ...requiredRole(
          "signed-in user (admin | staff | member)",
          "BetterAuth invalidates the current session cookie",
        ),
        responses: {
          "200": jsonResponse("Session ended", otpSuccessSchema),
          "401": authErrorResponse,
        },
      },
    },
    "/api/auth/email-otp/send-verification-otp": {
      post: {
        tags: ["auth"],
        operationId: "sendEmailVerificationOtp",
        summary: "Send email OTP code",
        ...requiredRole(
          "none",
          "The BetterAuth emailOTP plugin sends a six-digit code for the specified purpose",
          false,
        ),
        requestBody: jsonBody(sendOtpRequestSchema),
        responses: {
          "200": jsonResponse(
            "Code delivery request processed",
            otpSuccessSchema,
          ),
          "400": authErrorResponse,
          "429": authErrorResponse,
        },
      },
    },
    "/api/auth/email-otp/verify-email": {
      post: {
        tags: ["auth"],
        operationId: "verifyEmailOtp",
        summary: "Verify email OTP code",
        ...requiredRole(
          "none",
          "The BetterAuth emailOTP plugin consumes the email verification code",
          false,
        ),
        requestBody: jsonBody(verifyEmailOtpRequestSchema),
        responses: {
          "200": jsonResponse("Email verified", verifyEmailOtpResponseSchema),
          "400": authErrorResponse,
          "403": authErrorResponse,
          "429": authErrorResponse,
        },
      },
    },
    "/api/auth/get-session": {
      get: {
        tags: ["auth"],
        operationId: "getSession",
        summary: "Get current session",
        ...requiredRole(
          "none; returns a session when the session cookie is present",
          "BetterAuth returns the current session and user record, or null",
          false,
        ),
        requestParams: { query: getSessionQuery },
        security: [{ sessionCookie: [] }, {}],
        responses: {
          "200": jsonResponse("Session or null", getSessionResponseSchema),
        },
      },
    },
    "/api/admin/initial-password": {
      post: {
        tags: ["admin"],
        operationId: "changeInitialPassword",
        summary: "Change initial sign-in password",
        ...requiredRole(
          "owner | admin | staff | member",
          "Completes the mandatory initial password change",
        ),
        requestBody: jsonBody(initialPasswordRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Password changed", okSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users": {
      get: {
        tags: ["admin"],
        operationId: "searchUsers",
        summary: "Search users",
        ...requiredRole(
          "owner | admin | staff",
          "Returns up to 20 users by phone, email, first name, or last name",
        ),
        requestParams: { query: userSearchQuery },
        responses: protectedResponses({
          "200": jsonResponse("Matching users", z.array(publicUserSchema)),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/directory": {
      get: {
        tags: ["admin"],
        operationId: "listUserDirectory",
        summary: "User directory",
        ...requiredRole(
          "owner | admin | staff",
          "Chain-wide paged user table with filters and derived subscription status. Roles, status and gym filters accept comma-separated values; a gym outside the caller's scope is refused with GYM_OUT_OF_SCOPE",
        ),
        requestParams: { query: userDirectoryQuerySchema },
        responses: protectedResponses({
          "200": jsonResponse("Directory page", userDirectoryPageSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/{id}": {
      get: {
        tags: ["admin"],
        operationId: "getMemberDetail",
        summary: "Member detail",
        ...requiredRole(
          "owner | admin | staff",
          "Directory row, ban, freeze state and pending deletion request in one call",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Member detail", memberDetailSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/{id}/ban": {
      post: {
        tags: ["admin"],
        operationId: "banMember",
        summary: "Ban a member",
        ...requiredRole(
          "owner | admin",
          "Refuses the member's entry scans (exits are never refused); re-banning updates the reason. Members only",
        ),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(banMemberRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Member banned", okSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
        }),
      },
      delete: {
        tags: ["admin"],
        operationId: "unbanMember",
        summary: "Lift a member ban",
        ...requiredRole(
          "owner | admin",
          "Clears the ban; NOT_BANNED when none",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Ban lifted", okSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/{id}/freeze": {
      post: {
        tags: ["admin"],
        operationId: "freezeMember",
        summary: "Freeze a member's subscription",
        ...requiredRole(
          "owner | admin | staff",
          "Freezes the running period. Refused with FREEZE_DISABLED, ALREADY_FROZEN, NO_ACTIVE_PERIOD or FREEZE_LIMIT_REACHED",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Membership frozen", okSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
      delete: {
        tags: ["admin"],
        operationId: "unfreezeMember",
        summary: "Resume a frozen subscription",
        ...requiredRole(
          "owner | admin | staff",
          "Ends the freeze and credits min(frozen time, maxDays) back to the member's periods",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Membership resumed", okSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/{id}/deletion-request": {
      post: {
        tags: ["admin"],
        operationId: "requestMemberDeletion",
        summary: "Open a deletion request on a member's behalf",
        ...requiredRole(
          "owner | admin | staff",
          "Creates a pending request recording who asked and why; only an owner can approve it",
        ),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(createMemberDeletionRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Request created", okSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/{id}/role": {
      post: {
        tags: ["admin"],
        operationId: "assignUserRole",
        summary: "Change user role",
        ...requiredRole(
          "owner",
          "Assigns a role to the target user; mfaCode and mfaMethod are required for an MFA-enabled administrator",
        ),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(roleRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Role assigned", okSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
          "429": apiErrorResponse,
        }),
      },
    },
    "/api/admin/subscriptions": {
      post: {
        tags: ["admin"],
        operationId: "createSubscription",
        summary: "Sell a subscription period",
        ...requiredRole(
          "owner | admin | staff (access to every listed gym)",
          "Appends a sequential, priced period to the member's timeline: a catalog package (staff sells at the catalog price) or, owner/admin only, a price override or a custom day grant. A repeated requestId returns the existing period if a gym on it is in the caller's scope, even after gym deactivation. Errors: PRICE_OVERRIDE_FORBIDDEN, PACKAGE_PRICE_UNSET, PACKAGE_PRICE_CHANGED (confirmed currency or duration differs, or expectedPriceMinor differs without override), PACKAGE_INACTIVE, REQUEST_ID_CONFLICT",
        ),
        requestBody: jsonBody(createSubscriptionRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse(
            "Subscription created",
            createSubscriptionResponseSchema,
          ),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/admin/subscriptions/{id}/payments": {
      get: {
        tags: ["admin"],
        operationId: "listSubscriptionPayments",
        summary: "List the payments of a period",
        ...requiredRole(
          "owner | admin | staff (a gym of the period must be in scope)",
          "Voided payments are included and marked",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Payments, newest first", z.array(paymentSchema)),
          "404": apiErrorResponse,
        }),
      },
      post: {
        tags: ["admin"],
        operationId: "recordPayment",
        summary: "Record a payment against a sold period",
        ...requiredRole(
          "owner | admin | staff (gymId in scope and on the period)",
          "Runs under the member's subscription lock; amountMinor above the balance is PAYMENT_EXCEEDS_BALANCE. A repeated requestId returns the existing payment. Errors: SUBSCRIPTION_UNPRICED, PAYMENT_GYM_NOT_ON_PERIOD, REQUEST_ID_CONFLICT",
        ),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(recordPaymentRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Payment and new balance", paymentResultSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/admin/subscriptions/{id}/sale": {
      patch: {
        tags: ["admin"],
        operationId: "updateSubscriptionSale",
        summary: "Change the promised payment date of a period",
        ...requiredRole(
          "owner | admin (a gym of the period must be in scope)",
          "Sets or clears nextPaymentDue; the price and payments are untouched",
        ),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(updateSubscriptionSaleRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Updated period", subscriptionSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
        }),
      },
    },
    "/api/admin/payments/{id}/void": {
      post: {
        tags: ["admin"],
        operationId: "voidPayment",
        summary: "Void a payment",
        ...requiredRole(
          "owner | admin (the payment's gym must be in scope)",
          "Under the member's subscription lock, shared with account erasure. Erased members return PAYMENT_NOT_FOUND. Once only (PAYMENT_ALREADY_VOIDED); a voided payment no longer counts toward the balance or cash totals",
        ),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(voidPaymentRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse(
            "Voided payment and new balance",
            paymentResultSchema,
          ),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/admin/packages": {
      get: {
        tags: ["admin"],
        operationId: "listPackages",
        summary: "List catalog packages",
        ...requiredRole(
          "owner | admin | staff",
          "Active packages for the sale modal; all=true (owner only) also lists inactive ones",
        ),
        requestParams: {
          query: z.object({ all: z.enum(["true", "false"]).optional() }),
        },
        responses: protectedResponses({
          "200": jsonResponse(
            "Packages and chain currency",
            packageListResponseSchema,
          ),
          "400": apiErrorResponse,
        }),
      },
      post: {
        tags: ["admin"],
        operationId: "createPackage",
        summary: "Create a catalog package",
        ...requiredRole("owner", "Adds a package to the chain-wide catalog"),
        requestBody: jsonBody(createPackageRequestSchema),
        responses: protectedResponses({
          "201": jsonResponse("Package created", packageSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/packages/{id}": {
      patch: {
        tags: ["admin"],
        operationId: "updatePackage",
        summary: "Update or deactivate a catalog package",
        ...requiredRole(
          "owner",
          "Partial update; packages are never deleted. A price change is audited with the old and new price",
        ),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(updatePackageRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Updated package", packageSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}/reports/cash": {
      get: {
        tags: ["admin"],
        operationId: "getCashReport",
        summary: "Daily cash report",
        ...requiredRole(
          "owner | admin (gym in scope)",
          "Non-voided payments recorded at the gym during one local day in REPORTS_TIME_ZONE (default: today); voided ones are listed apart",
        ),
        requestParams: {
          path: gymIdPathParams,
          query: z.object({ day: dayLabelQuerySchema.optional() }),
        },
        responses: protectedResponses({
          "200": jsonResponse("Cash report", cashReportSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}/reports/debtors": {
      get: {
        tags: ["admin"],
        operationId: "listDebtors",
        summary: "Periods with an outstanding balance",
        ...requiredRole(
          "owner | admin | staff (gym in scope)",
          "Overdue first, then by due date, then larger balance first; keyset paged",
        ),
        requestParams: { path: gymIdPathParams, query: pageQuerySchema },
        responses: protectedResponses({
          "200": jsonResponse("Debtors", pageSchema(debtorRowSchema)),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
        }),
      },
    },
    "/api/admin/subscriptions/{id}": {
      delete: {
        tags: ["admin"],
        operationId: "cancelSubscription",
        summary: "Cancel a subscription period that has not started",
        ...requiredRole(
          "owner | admin | staff (access to every gym on the period)",
          "Deletes a not-yet-started period and moves the member's later periods earlier by its duration; refused with SUBSCRIPTION_STARTED once it has begun and with SUBSCRIPTION_HAS_PAYMENTS while it has non-voided payments",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse(
            "Period cancelled; later periods with their new dates",
            cancelSubscriptionResponseSchema,
          ),
          "404": apiErrorResponse,
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/admin/subscriptions/{id}/gyms": {
      put: {
        tags: ["admin"],
        operationId: "setSubscriptionGyms",
        summary: "Change the gyms of a subscription period",
        ...requiredRole(
          "owner | admin | staff (only gyms in scope may be added or removed)",
          "Replaces the gyms of a current or future period without changing its dates",
        ),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(setSubscriptionGymsRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse(
            "Updated subscription period",
            subscriptionSchema,
          ),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "409": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/{id}/subscriptions": {
      get: {
        tags: ["admin"],
        operationId: "listUserSubscriptions",
        summary: "List user subscriptions",
        ...requiredRole(
          "owner | admin | staff",
          "Returns the latest 50 subscription periods plus every older period with an outstanding balance visible to the caller, ordered by end date, creation date and id descending",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Subscriptions", z.array(subscriptionSchema)),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/settings": {
      get: {
        tags: ["admin"],
        operationId: "getChainSettings",
        summary: "Get chain settings",
        ...requiredRole(
          "owner | admin",
          "Returns the chain name and legal documents",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Chain settings", chainSettingsSchema),
        }),
      },
      put: {
        tags: ["admin"],
        operationId: "updateChainSettings",
        summary: "Update chain settings",
        ...requiredRole("owner", "Updates the chain name and legal documents"),
        requestBody: jsonBody(chainSettingsRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Settings updated", okSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/users/{id}/gyms": {
      put: {
        tags: ["admin"],
        operationId: "setUserGyms",
        summary: "Assign an admin/staff account to gyms",
        ...requiredRole("owner", "Replaces the account's gym scope"),
        requestParams: { path: idPathParams },
        requestBody: jsonBody(setUserGymsRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Gyms assigned", okSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms": {
      get: {
        tags: ["admin"],
        operationId: "listGyms",
        summary: "List gyms",
        ...requiredRole(
          "owner | admin | staff",
          "Every gym for the owner, the assigned gyms for admin/staff",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Gyms", z.array(gymSchema)),
        }),
      },
      post: {
        tags: ["admin"],
        operationId: "createGym",
        summary: "Create gym",
        ...requiredRole("owner", "Creates an active gym"),
        requestBody: jsonBody(createGymRequestSchema),
        responses: protectedResponses({
          "201": jsonResponse("Gym created", gymSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}": {
      get: {
        tags: ["admin"],
        operationId: "getGym",
        summary: "Get gym",
        ...requiredRole(
          "owner | admin | staff (scoped to the gym)",
          "Returns one gym",
        ),
        requestParams: { path: gymIdPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Gym", gymSchema),
          "404": apiErrorResponse,
        }),
      },
      put: {
        tags: ["admin"],
        operationId: "updateGym",
        summary: "Update or deactivate gym",
        ...requiredRole(
          "owner",
          "Partial update: name and/or active. Gyms are deactivated (`active: false`), never deleted; entry scans are refused while inactive",
        ),
        requestParams: { path: gymIdPathParams },
        requestBody: jsonBody(updateGymRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Updated gym", gymSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}/occupancy": {
      get: {
        tags: ["admin"],
        operationId: "getGymOccupancy",
        summary: "Get live occupancy of a gym",
        ...requiredRole(
          "owner | admin | staff (scoped to the gym)",
          "Live headcount",
        ),
        requestParams: { path: gymIdPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Occupancy", occupancySchema),
        }),
      },
    },
    "/api/admin/gyms/{gymId}/inside": {
      get: {
        tags: ["admin"],
        operationId: "getGymInside",
        summary: "List members counted inside a gym right now",
        ...requiredRole(
          "owner | admin | staff (scoped to the gym)",
          "Longest-staying first; length equals the occupancy figure",
        ),
        requestParams: { path: gymIdPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Members inside", gymInsideSchema),
        }),
      },
    },
    "/api/admin/gyms/{gymId}/settings": {
      get: {
        tags: ["admin"],
        operationId: "getGymSettings",
        summary: "Get gym settings",
        ...requiredRole(
          "owner | admin | staff (scoped to the gym)",
          "Returns the full Gym",
        ),
        requestParams: { path: gymIdPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Gym", gymSchema),
        }),
      },
      put: {
        tags: ["admin"],
        operationId: "updateGymSettings",
        summary: "Update gym settings",
        ...requiredRole(
          "owner | admin (scoped to the gym)",
          "Updates location, capacity, auto-exit, and optional sharing/reminder settings",
        ),
        requestParams: { path: gymIdPathParams },
        requestBody: jsonBody(gymSettingsRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Settings updated", okSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}/stats": {
      get: {
        tags: ["admin"],
        operationId: "getAdminStats",
        summary: "Get gym KPI values",
        ...requiredRole(
          "owner | admin | staff (scoped to the gym)",
          "Returns counts of active members and members due for renewal within seven days",
        ),
        requestParams: { path: gymIdPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Gym statistics", adminStatsSchema),
        }),
      },
    },
    "/api/admin/audit": {
      get: {
        tags: ["admin"],
        operationId: "listAuditLogs",
        summary: "List audit records",
        ...requiredRole(
          "owner | admin",
          "Returns sensitive operation records from newest to oldest with cursor pagination; optional gymId filter. Admins only see rows of gyms in their scope",
        ),
        requestParams: { query: auditQuerySchema },
        responses: protectedResponses({
          "200": jsonResponse("Audit record page", pageSchema(auditLogSchema)),
        }),
      },
    },
    "/api/admin/gyms/{gymId}/entry-events": {
      get: {
        tags: ["admin"],
        operationId: "listEntryEvents",
        summary: "List gate events of a gym",
        ...requiredRole(
          "owner | admin | staff (scoped to the gym)",
          "Returns allow and deny events from newest to oldest with cursor pagination",
        ),
        requestParams: { path: gymIdPathParams, query: entryEventQuerySchema },
        responses: protectedResponses({
          "200": jsonResponse("Gate event page", pageSchema(entryEventSchema)),
        }),
      },
    },
    "/api/admin/deletion-requests": {
      get: {
        tags: ["admin"],
        operationId: "listDeletionRequests",
        summary: "List account deletion requests",
        ...requiredRole(
          "owner",
          "Returns account deletion requests from newest to oldest with cursor pagination",
        ),
        requestParams: { query: deletionRequestQuerySchema },
        responses: protectedResponses({
          "200": jsonResponse(
            "Account deletion request page",
            pageSchema(deletionRequestSchema),
          ),
        }),
      },
    },
    "/api/admin/deletion-requests/{id}/approve": {
      post: {
        tags: ["admin"],
        operationId: "approveDeletionRequest",
        summary: "Approve account deletion request",
        ...requiredRole(
          "owner",
          "Atomically claims the pending request and permanently deletes user data",
        ),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Request approved", okSchema),
          "404": apiErrorResponse,
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/admin/deletion-requests/{id}/reject": {
      post: {
        tags: ["admin"],
        operationId: "rejectDeletionRequest",
        summary: "Reject account deletion request",
        ...requiredRole("owner", "Rejects a pending account deletion request"),
        requestParams: { path: idPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Request rejected", okSchema),
          "404": apiErrorResponse,
          "409": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}/gate-devices": {
      get: {
        tags: ["devices"],
        operationId: "listReceptionGateDevices",
        summary: "List reception-safe gate devices",
        ...requiredRole(
          "owner | admin | staff (scoped to the gym)",
          "Returns only id, name, direction and online status; no QR or token credentials",
        ),
        requestParams: { path: gymIdPathParams },
        responses: protectedResponses({
          "200": jsonResponse(
            "Reception gate devices",
            z.array(gateDeviceSummarySchema),
          ),
        }),
      },
    },
    "/api/admin/gyms/{gymId}/gate-open": {
      post: {
        tags: ["devices"],
        operationId: "openGateFromReception",
        summary: "Open a gate for a person from reception",
        ...requiredRole(
          "owner | admin | staff (scoped to the gym)",
          "Requires a reason. Evaluates the passing person's entry controls, skipping QR and location checks. Exits keep the QR flow's rules. Every scoped attempt is logged and audited. Limited to 30 requests per actor per 10 minutes; INVALID_DIRECTION when the device does not support the requested direction.",
        ),
        requestParams: { path: gymIdPathParams },
        requestBody: jsonBody(gateOpenRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Gate opened", gateScanResponseSchema),
          "400": apiErrorResponse,
          "404": apiErrorResponse,
          "429": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}/devices": {
      get: {
        tags: ["devices"],
        operationId: "listDevices",
        summary: "List gate devices",
        requestParams: { path: gymPathParams },
        ...requiredRole(
          "owner | admin (scoped to the gym)",
          "Returns devices with online status and 24-hour uptime; qrContent and the bidirectional exitQrContent are gate credentials",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Devices", z.array(deviceSchema)),
        }),
      },
      post: {
        tags: ["devices"],
        operationId: "createDevice",
        summary: "Create gate device",
        requestParams: { path: gymPathParams },
        ...requiredRole(
          "owner | admin (scoped to the gym)",
          "Registers an entry, exit, or bidirectional device; bidirectional devices have a signed QR per face. The plaintext device token appears only in this response",
        ),
        requestBody: jsonBody(createDeviceRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Device created", deviceCreatedSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/admin/gyms/{gymId}/devices/{id}": {
      delete: {
        tags: ["devices"],
        operationId: "deleteDevice",
        summary: "Delete gate device",
        ...requiredRole(
          "owner | admin (scoped to the gym)",
          "Deletes the device record and active gateway connection",
        ),
        requestParams: { path: gymPathParams.extend(idPathParams.shape) },
        responses: protectedResponses({
          "200": jsonResponse("Device deleted", okSchema),
          "404": apiErrorResponse,
        }),
      },
    },
    "/api/me/profile": {
      get: {
        tags: ["me"],
        operationId: "getMyProfile",
        summary: "Get my current profile",
        ...requiredRole(
          "admin | staff | member",
          "Returns the profile with role and security flags read fresh from MongoDB",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Current profile", myProfileSchema),
        }),
      },
    },
    "/api/me/body-metrics": {
      patch: {
        tags: ["me"],
        operationId: "patchMyBodyMetrics",
        summary: "Update my age, height, and weight",
        ...requiredRole(
          "admin | staff | member",
          "Fields used to prefill the calorie calculator. This endpoint replaces BetterAuth's update-user endpoint so writes pass through role checks and a fresh user read. When weight changes, a timestamped record is added to weight history",
        ),
        requestBody: jsonBody(myBodyMetricsUpdateSchema),
        responses: protectedResponses({
          "200": jsonResponse("Current body metrics", myBodyMetricsSchema),
          "400": jsonResponse("Invalid body metrics", apiErrorSchema),
        }),
      },
    },
    "/api/me/weight-history": {
      get: {
        tags: ["me"],
        operationId: "getMyWeightHistory",
        summary: "Get my weight history",
        ...requiredRole(
          "admin | staff | member",
          "Timestamped records added whenever profile weight changes, sorted in ascending time order",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Weight history", myWeightHistorySchema),
        }),
      },
    },
    "/api/me/profile-photo": {
      put: {
        tags: ["me"],
        operationId: "putMyProfilePhoto",
        summary: "Upload my profile photo",
        ...requiredRole(
          "member",
          "Normalizes the raw image body and stores it as the profile photo",
        ),
        requestBody: {
          required: true,
          content: {
            "image/jpeg": { schema: binaryImageSchema },
            "image/png": { schema: binaryImageSchema },
            "image/webp": { schema: binaryImageSchema },
            "application/octet-stream": { schema: binaryImageSchema },
          },
        },
        responses: protectedResponses({
          "200": jsonResponse(
            "Profile photo updated",
            profilePhotoResponseSchema,
          ),
          "400": apiErrorResponse,
          "409": apiErrorResponse,
          "413": apiErrorResponse,
          "429": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
      delete: {
        tags: ["me"],
        operationId: "deleteMyProfilePhoto",
        summary: "Delete my profile photo",
        ...requiredRole("member", "Removes the stored profile photo"),
        responses: protectedResponses({
          "200": jsonResponse(
            "Profile photo removed",
            profilePhotoResponseSchema,
          ),
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/me/subscription": {
      get: {
        tags: ["me"],
        operationId: "getMySubscription",
        summary: "Get my subscription",
        ...requiredRole(
          "admin | staff | member",
          "Returns the active subscription summary for the signed-in user",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Subscription summary", mySubscriptionSchema),
        }),
      },
    },
    "/api/me/entries": {
      get: {
        tags: ["me"],
        operationId: "getMyEntries",
        summary: "Get my entry days",
        ...requiredRole(
          "admin | staff | member",
          "Returns the signed-in user's entry days in the provided range, grouped by the gym time zone",
        ),
        requestParams: { query: myEntriesQuery },
        responses: protectedResponses({
          "200": jsonResponse("Entry days", myEntriesSchema),
          "400": apiErrorResponse,
        }),
      },
    },
    "/api/me/presence": {
      get: {
        tags: ["me"],
        operationId: "getMyPresence",
        summary: "Get my presence",
        ...requiredRole(
          "owner | admin | staff | member",
          "Returns where the caller currently counts as inside and their latest allowed entry scan",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Presence", myPresenceSchema),
        }),
      },
    },
    "/api/me/gyms/{gymId}/busy-hours": {
      get: {
        tags: ["me"],
        operationId: "getMyGymBusyHours",
        summary: "Get a gym's typical entry traffic by hour",
        ...requiredRole(
          "owner | admin | staff | member",
          "Average allowed entries per hour over the last four same-weekday days; hours with fewer than 3 entries in total report 0. The gym must be one GET /api/me/subscription lists (a frozen member keeps the gyms of the freeze-credited preview), otherwise (or for an unknown id) GYM_OUT_OF_SCOPE",
        ),
        requestParams: { path: gymPathParams },
        responses: protectedResponses({
          "200": jsonResponse("Busy hours", myBusyHoursSchema),
          "403": apiErrorResponse,
        }),
      },
    },
    "/api/me/gate-scan": {
      post: {
        tags: ["me"],
        operationId: "scanGate",
        summary: "Request gate entry by QR",
        ...requiredRole(
          "admin | staff | member",
          "Validates the static QR, subscription, location, sharing signals, and device status, then opens the gate",
        ),
        requestBody: jsonBody(gateScanRequestSchema),
        responses: protectedResponses({
          "200": jsonResponse("Gate opened", gateScanResponseSchema),
          "400": apiErrorResponse,
          "429": apiErrorResponse,
        }),
      },
    },
    "/api/me/freeze": {
      post: {
        tags: ["me"],
        operationId: "freezeMySubscription",
        summary: "Freeze my subscription",
        ...requiredRole(
          "member",
          "Self-service freeze of the running period. FREEZE_DISABLED when freezing or member self-service is off; BANNED for a banned member",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Membership frozen", okSchema),
          "403": apiErrorResponse,
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
      delete: {
        tags: ["me"],
        operationId: "resumeMySubscription",
        summary: "Resume my frozen subscription",
        ...requiredRole(
          "member",
          "Always allowed, so a member is never stuck frozen; credits min(frozen time, maxDays) back",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Membership resumed", okSchema),
          "409": apiErrorResponse,
          "503": apiErrorResponse,
        }),
      },
    },
    "/api/me/occupancy": {
      get: {
        tags: ["me"],
        operationId: "getOccupancy",
        summary: "Get gym occupancy",
        ...requiredRole(
          "owner | admin | staff | member",
          "Returns the live number of people inside and the capacity ratio of every active gym the caller may enter",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Gym occupancy", myOccupancySchema),
        }),
      },
    },
    "/api/me/deletion-request": {
      get: {
        tags: ["me"],
        operationId: "getMyDeletionRequest",
        summary: "Get my account deletion request",
        ...requiredRole(
          "admin | staff | member",
          "Returns the latest deletion request status for the signed-in user",
        ),
        responses: protectedResponses({
          "200": jsonResponse(
            "Deletion request status",
            myDeletionRequestSchema,
          ),
        }),
      },
      post: {
        tags: ["me"],
        operationId: "createMyDeletionRequest",
        summary: "Create account deletion request",
        ...requiredRole(
          "member (middleware accepts admin | staff | member; the operation checks the member role separately)",
          "Creates a pending account deletion request for the signed-in member",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Request created", okSchema),
          "409": apiErrorResponse,
        }),
      },
      delete: {
        tags: ["me"],
        operationId: "cancelMyDeletionRequest",
        summary: "Withdraw account deletion request",
        ...requiredRole(
          "admin | staff | member",
          "Removes the signed-in user's pending deletion request",
        ),
        responses: protectedResponses({
          "200": jsonResponse("Request withdrawn", okSchema),
          "404": apiErrorResponse,
        }),
      },
    },
  },
});
