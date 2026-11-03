import { Router } from "express";
import { ObjectId } from "mongodb";
import type { MyDeletionRequest } from "@opengym/shared";
import { db, isDuplicateKeyError } from "../../core/db.js";
import { sendApiError } from "../../core/apiError.js";
import { authed, requireRole } from "../../core/middleware.js";
import { logAudit } from "../../core/audit.js";

export const deletionRequestRouter: Router = Router();

// Phase 5 — Data protection: member's own account deletion request status
deletionRequestRouter.get(
  "/deletion-request",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const latest = await db
      .collection("deletion_requests")
      .find({ userId: new ObjectId(req.user.id) })
      .sort({ requestedAt: -1 })
      .limit(1)
      .next();
    const body: MyDeletionRequest = latest
      ? {
          status:
            latest.status === "pending"
              ? "pending"
              : latest.status === "rejected"
                ? "rejected"
                : "none",
          requestedAt: latest.requestedAt
            ? new Date(latest.requestedAt).toISOString()
            : null,
        }
      : { status: "none", requestedAt: null };
    res.json(body);
  }),
);

// Data protection: create an account deletion request — members may request only for their own account
deletionRequestRouter.post(
  "/deletion-request",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    if (req.user.role !== "member") {
      sendApiError(
        res,
        403,
        "DELETION_MEMBER_ONLY",
        "Only member accounts can create a deletion request.",
      );
      return;
    }
    const userId = new ObjectId(req.user.id);
    // This check does not guarantee uniqueness; the partial unique index on
    // deletion_requests does. Read-then-write is not atomic, so concurrent
    // requests could create two pending requests for one member. This precheck
    // is only a cheaper path for the common case.
    const existingPending = await db
      .collection("deletion_requests")
      .findOne({ userId, status: "pending" });
    if (existingPending) {
      sendApiError(
        res,
        409,
        "DELETION_ALREADY_PENDING",
        "You already have a pending deletion request.",
      );
      return;
    }
    try {
      await db.collection("deletion_requests").insertOne({
        userId,
        email: req.user.email,
        name: req.user.name,
        requestedAt: new Date(),
        status: "pending",
        resolvedAt: null,
        resolvedBy: null,
        requestedBy: null,
        reason: null,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        sendApiError(
          res,
          409,
          "DELETION_ALREADY_PENDING",
          "You already have a pending deletion request.",
        );
        return;
      }
      throw err;
    }
    await logAudit(req.user, "account-deletion-requested");
    res.json({ ok: true });
  }),
);

// Data protection: withdraw a pending deletion request
deletionRequestRouter.delete(
  "/deletion-request",
  requireRole("owner", "admin", "staff", "member"),
  authed(async (req, res) => {
    const result = await db.collection("deletion_requests").deleteOne({
      userId: new ObjectId(req.user.id),
      status: "pending",
    });
    if (result.deletedCount === 0) {
      sendApiError(
        res,
        404,
        "DELETION_NOT_PENDING",
        "No pending deletion request was found.",
      );
      return;
    }
    await logAudit(req.user, "account-deletion-cancelled");
    res.json({ ok: true });
  }),
);
