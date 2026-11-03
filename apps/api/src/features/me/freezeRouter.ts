import express, { Router } from "express";
import { ObjectId } from "mongodb";
import { sendApiError } from "../../core/apiError.js";
import { authed, requireRole } from "../../core/middleware.js";
import { endFreeze, startFreeze } from "../freeze/freeze.js";
import { SubscriptionLockTimeoutError } from "../subscriptions/subscriptions.js";
import { logMemberAudit } from "../members/memberScope.js";

export const freezeRouter: Router = Router();

// Member self-service freeze (docs/member-controls.md). Same service, lock and
// credit logic as the admin routes; the member is the actor.
function sendFreezeRefusal(
  res: express.Response,
  status:
    | "disabled"
    | "out-of-scope"
    | "already-frozen"
    | "no-active-period"
    | "limit-reached",
): void {
  switch (status) {
    case "out-of-scope":
      // Unreachable for self-service (no scope callback); kept exhaustive.
      sendApiError(res, 403, "GYM_OUT_OF_SCOPE", "Not allowed.");
      return;
    case "disabled":
      sendApiError(
        res,
        409,
        "FREEZE_DISABLED",
        "Subscription freezing is turned off.",
      );
      return;
    case "already-frozen":
      sendApiError(
        res,
        409,
        "ALREADY_FROZEN",
        "This membership is already frozen.",
      );
      return;
    case "no-active-period":
      sendApiError(
        res,
        409,
        "NO_ACTIVE_PERIOD",
        "You have no subscription period running right now.",
      );
      return;
    case "limit-reached":
      sendApiError(
        res,
        409,
        "FREEZE_LIMIT_REACHED",
        "The yearly freeze limit has been reached.",
      );
      return;
  }
}

function sendSubscriptionBusy(res: express.Response): void {
  sendApiError(
    res,
    503,
    "SUBSCRIPTION_BUSY",
    "A subscription operation is in progress. Please try again.",
  );
}

freezeRouter.post(
  "/freeze",
  requireRole("member"),
  authed(async (req, res) => {
    if (req.user.ban) {
      sendApiError(
        res,
        403,
        "BANNED",
        "Your account is banned. Contact reception.",
      );
      return;
    }
    try {
      const result = await startFreeze(new ObjectId(req.user.id), req.user.id, {
        selfService: true,
      });
      if (result.status !== "started") {
        sendFreezeRefusal(res, result.status);
        return;
      }
      await logMemberAudit(
        req.user,
        "subscription-frozen",
        new ObjectId(req.user.id),
        {
          freezeId: result.freeze._id.toHexString(),
          startedAt: result.freeze.startedAt.toISOString(),
          maxDays: result.freeze.maxDays,
          selfService: true,
        },
      );
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendSubscriptionBusy(res);
        return;
      }
      throw error;
    }
  }),
);

// Resume is always allowed (even when freezing was switched off or the member
// is banned), so a member can never be stuck frozen.
freezeRouter.delete(
  "/freeze",
  requireRole("member"),
  authed(async (req, res) => {
    try {
      const result = await endFreeze(new ObjectId(req.user.id), {
        reason: "resumed",
        endedBy: req.user.id,
      });
      if (result.status !== "ended") {
        // "out-of-scope" cannot happen here (no scope callback is passed).
        sendApiError(res, 409, "NOT_FROZEN", "This membership is not frozen.");
        return;
      }
      await logMemberAudit(
        req.user,
        "subscription-unfrozen",
        new ObjectId(req.user.id),
        {
          freezeId: result.freeze._id.toHexString(),
          startedAt: result.freeze.startedAt.toISOString(),
          endedAt: result.freeze.endedAt?.toISOString() ?? null,
          creditedMs: result.creditedMs,
          reason: "resumed",
          selfService: true,
        },
      );
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof SubscriptionLockTimeoutError) {
        sendSubscriptionBusy(res);
        return;
      }
      throw error;
    }
  }),
);
