import { Router, type Response } from "express";
import { ObjectId } from "mongodb";
import { APIError } from "better-auth/api";
import { auth, runAsInviteSignup } from "../../auth/auth.js";
import { sendApiError } from "../../core/apiError.js";
import { logAudit } from "../../core/audit.js";
import {
  findChainSettings,
  isDuplicateKeyError,
  toObjectId,
  userCollection,
} from "../../core/db.js";
import { gymScoped, requireGymAccess } from "../../core/middleware.js";
import { hasActivePhoneConflict } from "../../repairs/phoneBackfill.js";
import {
  INVALID_PHONE_MESSAGE,
  InvalidPhoneNumberError,
  normalizePhoneToE164,
  PHONE_ALREADY_EXISTS_CODE,
  PHONE_ALREADY_EXISTS_MESSAGE,
} from "../../lib/phone.js";
import { getLegalConfig } from "../settings/legal.js";
import {
  availableInviteClaim,
  hashInviteToken,
  INVITE_ACCEPTING_TIMEOUT_MS,
  INVITE_LIFETIME_MS,
  INVITE_RESEND_LIMIT,
  inviteResendWaitMs,
  isInviteRateLimited,
  memberInvites,
  newInviteToken,
  toMemberInvite,
  withInviteLock,
  type MemberInviteDocument,
} from "./invites.js";
import { sendInviteMail } from "./mail.js";
import {
  acceptInviteSchema,
  createInviteSchema,
  lookupInviteSchema,
} from "./schemas.js";

function invalidInvite(res: Response): void {
  sendApiError(
    res,
    404,
    "INVITE_INVALID",
    "This invitation is invalid or has expired.",
  );
}

function inviteAccepting(res: Response): void {
  sendApiError(
    res,
    409,
    "INVITE_ACCEPTING",
    "This invitation is being accepted. Please try again shortly.",
  );
}

function rateLimited(res: Response, retryAfter: number): void {
  res.setHeader("Retry-After", String(retryAfter));
  sendApiError(
    res,
    429,
    "RATE_LIMITED",
    "Too many requests. Please try again later.",
  );
}

// Never copy the invite's contact details into the permanent audit trail.
async function auditInvite(
  actorId: string,
  action: string,
  invite: MemberInviteDocument,
): Promise<void> {
  await logAudit(
    { id: actorId, email: "" },
    action,
    invite._id.toHexString(),
    undefined,
    invite.gymId,
  );
}

export const adminInvitesRouter: Router = Router({ mergeParams: true });
adminInvitesRouter.use(requireGymAccess("owner", "admin", "staff"));

adminInvitesRouter.post(
  "/",
  gymScoped(async (req, res) => {
    if (await isInviteRateLimited(`og:invite-create:${req.user.id}`, 3600)) {
      rateLimited(res, 3600);
      return;
    }
    const parsed = createInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Enter valid invitation details.",
      );
      return;
    }
    const data = parsed.data;
    let phone: string;
    try {
      phone = normalizePhoneToE164(data.phone);
    } catch (error) {
      if (!(error instanceof InvalidPhoneNumberError)) throw error;
      sendApiError(res, 400, "INVALID_PHONE_NUMBER", INVALID_PHONE_MESSAGE);
      return;
    }
    if (
      await userCollection().findOne(
        { email: data.email },
        { projection: { _id: 1 } },
      )
    ) {
      sendApiError(
        res,
        409,
        "EMAIL_TAKEN",
        "An account with this email already exists.",
      );
      return;
    }
    const now = new Date();
    // TTL cleanup is asynchronous; an expired row must not reserve an email.
    await memberInvites().deleteOne({
      email: data.email,
      expiresAt: { $lte: now },
    });
    if (
      await memberInvites().findOne(
        { email: data.email },
        { projection: { _id: 1 } },
      )
    ) {
      sendApiError(
        res,
        409,
        "INVITE_EXISTS",
        "A pending invitation for this email already exists.",
      );
      return;
    }
    if (
      (await userCollection().findOne(
        { phoneE164: phone },
        { projection: { _id: 1 } },
      )) ||
      (await hasActivePhoneConflict(phone))
    ) {
      sendApiError(
        res,
        400,
        PHONE_ALREADY_EXISTS_CODE,
        PHONE_ALREADY_EXISTS_MESSAGE,
      );
      return;
    }
    const { token, tokenHash } = newInviteToken();
    const invite: MemberInviteDocument = {
      _id: new ObjectId(),
      ...data,
      phone,
      gymId: req.gym._id.toHexString(),
      tokenHash,
      expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
      createdBy: req.user.id,
      createdAt: now,
      resentAt: null,
      resendCount: 0,
    };
    try {
      await memberInvites().insertOne(invite);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      sendApiError(
        res,
        409,
        "INVITE_EXISTS",
        "A pending invitation for this email already exists.",
      );
      return;
    }
    await auditInvite(req.user.id, "invite-created", invite);
    await sendInviteMail(invite, token);
    res.status(201).json(await toMemberInvite(invite));
  }),
);

adminInvitesRouter.get(
  "/",
  gymScoped(async (req, res) => {
    const invites = await memberInvites()
      .find({
        gymId: req.gym._id.toHexString(),
        expiresAt: { $gt: new Date() },
      })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(await Promise.all(invites.map(toMemberInvite)));
  }),
);

for (const operation of ["resend", "cancel"] as const) {
  const handler = gymScoped(async (req, res) => {
    const id = toObjectId(String(req.params.id));
    const filter = {
      _id: id ?? new ObjectId(),
      gymId: req.gym._id.toHexString(),
      expiresAt: { $gt: new Date() },
    };
    const initial = id ? await memberInvites().findOne(filter) : null;
    if (!initial) {
      invalidInvite(res);
      return;
    }
    const result = await withInviteLock(initial.tokenHash, async () => {
      const invite = await memberInvites().findOne({
        ...filter,
        tokenHash: initial.tokenHash,
        expiresAt: { $gt: new Date() },
      });
      if (!invite) {
        invalidInvite(res);
        return true;
      }
      const now = new Date();
      if (
        invite.acceptingAt &&
        invite.acceptingAt.getTime() >=
          now.getTime() - INVITE_ACCEPTING_TIMEOUT_MS
      ) {
        inviteAccepting(res);
        return true;
      }
      // Acceptance can claim after the read above, so guard each write too.
      const mutationFilter = {
        ...filter,
        tokenHash: invite.tokenHash,
        ...availableInviteClaim(now),
      };
      const mutationFailed = async () => {
        const current = await memberInvites().findOne(filter);
        if (
          current?.acceptingAt &&
          current.acceptingAt.getTime() >=
            Date.now() - INVITE_ACCEPTING_TIMEOUT_MS
        ) {
          inviteAccepting(res);
        } else {
          invalidInvite(res);
        }
      };
      if (operation === "cancel") {
        const deleted = await memberInvites().deleteOne(mutationFilter);
        if (!deleted.deletedCount) {
          await mutationFailed();
          return true;
        }
        await auditInvite(req.user.id, "invite-cancelled", invite);
        res.json({ ok: true });
        return true;
      }
      if (invite.resendCount >= INVITE_RESEND_LIMIT) {
        sendApiError(
          res,
          409,
          "INVITE_RESEND_LIMIT",
          "This invitation has reached its resend limit.",
        );
        return true;
      }
      const wait = inviteResendWaitMs(invite, now);
      if (wait > 0) {
        rateLimited(res, Math.ceil(wait / 1000));
        return true;
      }
      const { token, tokenHash } = newInviteToken();
      const updated = {
        ...invite,
        tokenHash,
        resentAt: now,
        expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
        resendCount: invite.resendCount + 1,
      };
      const result = await memberInvites().updateOne(mutationFilter, {
        $set: { tokenHash, resentAt: now, expiresAt: updated.expiresAt },
        $inc: { resendCount: 1 },
      });
      if (!result.matchedCount) {
        await mutationFailed();
        return true;
      }
      await auditInvite(req.user.id, "invite-resent", updated);
      await sendInviteMail(updated, token);
      res.json(await toMemberInvite(updated));
      return true;
    });
    if (result === null) rateLimited(res, 1);
  });
  if (operation === "resend") adminInvitesRouter.post("/:id/resend", handler);
  else adminInvitesRouter.delete("/:id", handler);
}

export const publicInvitesRouter: Router = Router();
publicInvitesRouter.use(async (req, res, next) => {
  if (
    await isInviteRateLimited(`og:invite-public:${req.ip ?? "unknown"}`, 600)
  ) {
    rateLimited(res, 600);
    return;
  }
  // These responses contain personal data and must never be cached.
  res.setHeader("Cache-Control", "no-store");
  next();
});

publicInvitesRouter.post("/lookup", async (req, res) => {
  const parsed = lookupInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidInvite(res);
    return;
  }
  const invite = await memberInvites().findOne({
    tokenHash: hashInviteToken(parsed.data.token),
    expiresAt: { $gt: new Date() },
  });
  if (!invite) {
    invalidInvite(res);
    return;
  }
  const [settings, legal] = await Promise.all([
    findChainSettings(),
    getLegalConfig(),
  ]);
  res.json({
    firstName: invite.firstName,
    email: invite.email,
    chainName: settings?.chainName || "OpenGym",
    legal,
  });
});

publicInvitesRouter.post("/accept", async (req, res) => {
  if (!lookupInviteSchema.safeParse(req.body).success) {
    invalidInvite(res);
    return;
  }
  const parsed = acceptInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    sendApiError(
      res,
      400,
      "INVALID_REQUEST",
      "A valid password and both consents are required.",
    );
    return;
  }
  const { token, password, legalVersion } = parsed.data;
  const tokenHash = hashInviteToken(token);
  const acceptingAt = new Date();
  const invite = await memberInvites().findOneAndUpdate(
    {
      tokenHash,
      expiresAt: { $gt: acceptingAt },
      ...availableInviteClaim(acceptingAt),
    },
    { $set: { acceptingAt } },
    { returnDocument: "after" },
  );
  if (!invite) {
    invalidInvite(res);
    return;
  }
  const claimFilter = { _id: invite._id, acceptingAt };
  const releaseClaim = () =>
    memberInvites().updateOne(claimFilter, { $unset: { acceptingAt: "" } });
  try {
    const legal = await getLegalConfig();
    if (legal.version !== legalVersion) {
      await releaseClaim();
      sendApiError(
        res,
        409,
        "LEGAL_VERSION_CHANGED",
        "The legal documents changed. Review them again.",
      );
      return;
    }
    if (
      await userCollection().findOne(
        { email: invite.email },
        { projection: { _id: 1 } },
      )
    ) {
      await releaseClaim();
      sendApiError(
        res,
        409,
        "EMAIL_TAKEN",
        "An account with this email already exists.",
      );
      return;
    }
    const created = await runAsInviteSignup(legalVersion, () =>
      auth.api.signUpEmail({
        body: {
          email: invite.email,
          name: `${invite.firstName} ${invite.lastName}`,
          firstName: invite.firstName,
          lastName: invite.lastName,
          phone: invite.phone,
          password,
          dataProcessingAccepted: true,
          privacyAccepted: true,
        },
      }),
    );
    const context = await auth.$context;
    // Verification-required signup can return a synthetic duplicate response.
    // Never verify an existing account on the strength of that response.
    const actual = await context.internalAdapter.findUserById(created.user.id);
    if (!actual || actual.email !== invite.email) {
      await releaseClaim();
      sendApiError(
        res,
        409,
        "EMAIL_TAKEN",
        "An account with this email already exists.",
      );
      return;
    }
    const verified = await context.internalAdapter.updateUser(actual.id, {
      emailVerified: true,
    });
    if (!verified?.emailVerified)
      throw new Error("Invite email verification failed.");
    await auditInvite(actual.id, "invite-accepted", invite);
    const deleted = await memberInvites().deleteOne(claimFilter);
    if (!deleted.deletedCount) {
      console.warn("Invite acceptance completed after its claim was lost.");
    }
    res.json({ ok: true });
  } catch (error) {
    await releaseClaim();
    if (
      error instanceof APIError &&
      error.body?.code === PHONE_ALREADY_EXISTS_CODE
    ) {
      sendApiError(
        res,
        400,
        PHONE_ALREADY_EXISTS_CODE,
        PHONE_ALREADY_EXISTS_MESSAGE,
      );
    } else if (
      error instanceof APIError &&
      error.body?.code === "LEGAL_VERSION_CHANGED"
    ) {
      sendApiError(
        res,
        409,
        "LEGAL_VERSION_CHANGED",
        "The legal documents changed. Review them again.",
      );
    } else {
      throw error;
    }
  }
});
