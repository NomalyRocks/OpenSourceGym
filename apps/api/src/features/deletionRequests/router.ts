import { Router } from "express";
import type { ObjectId } from "mongodb";
import { z } from "zod";
import type { DeletionRequest, Page } from "@opengym/shared";
import { sendApiError } from "../../core/apiError.js";
import {
  db,
  toObjectId,
  userCollection,
  weightHistoryCollection,
} from "../../core/db.js";
import { redis } from "../../core/redis.js";
import { withGateUserLifecycleLock } from "../gate/locks.js";
import { logAudit } from "../../core/audit.js";
import { authed, requireRole } from "../../core/middleware.js";
import { markOutsideEverywhere } from "../gyms/occupancy.js";
import { revokeUserSessions } from "../../auth/sessions.js";
import { deleteUserProfilePhotoForAccountDeletion } from "../profilePhoto/profilePhoto.js";
import { anonymisePaymentsForUser } from "../payments/payments.js";
import {
  subscriptionUserLockKey,
  SubscriptionLockTimeoutError,
  USER_LOCK_LEASE_MS,
  USER_LOCK_WAIT_MS,
  withRedisLock,
} from "../subscriptions/subscriptions.js";
import { FP_CHURN_KEY, QR_BLOCK_KEY, QR_LOC_KEY } from "../gate/sharing.js";
import {
  findPage,
  pageQuerySchema,
  toInvalidCursorResponse,
} from "../../lib/pagination.js";
import { reconcilePhoneConflictsAfterUserChange } from "../../repairs/phoneBackfill.js";

export const deletionRequestsRouter: Router = Router();

const deletionRequestQuerySchema = pageQuerySchema.extend({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

// Phase 5 — Data protection: account deletion request list (admin only)
// Cursor pagination + status filter
deletionRequestsRouter.get(
  "/deletion-requests",
  requireRole("owner"),
  async (req, res) => {
    const query = deletionRequestQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid list query parameters.",
      );
      return;
    }
    const { cursor, limit, status } = query.data;

    const page = await findPage(db.collection("deletion_requests"), {
      timeField: "requestedAt",
      filter: status ? { status } : {},
      cursor,
      limit,
    }).catch(toInvalidCursorResponse(res));
    if (!page) return;

    const body: Page<DeletionRequest> = {
      items: page.docs.map((d) => ({
        id: d._id.toString(),
        userId: (d.userId as ObjectId).toString(),
        email: d.email ?? "",
        name: d.name ?? "",
        requestedAt: (d.requestedAt as Date).toISOString(),
        status: d.status,
        resolvedAt: d.resolvedAt ? new Date(d.resolvedAt).toISOString() : null,
        resolvedBy: d.resolvedBy ?? null,
        requestedBy: d.requestedBy ?? null,
        reason: d.reason ?? null,
      })),
      nextCursor: page.nextCursor,
    };
    res.json(body);
  },
);

// Data protection: approve deletion — permanently deletes the member and all related data
deletionRequestsRouter.post(
  "/deletion-requests/:id/approve",
  requireRole("owner"),
  authed(async (req, res) => {
    const requestId = toObjectId(String(req.params.id ?? ""));
    if (!requestId) {
      sendApiError(
        res,
        404,
        "DELETION_REQUEST_NOT_FOUND",
        "Deletion request not found.",
      );
      return;
    }
    // TOCTOU protection: atomically claim the request from pending to approved.
    // If two admins approve concurrently, only one matches and the other gets
    // 409, preventing duplicate audit records and repeated processing.
    const claimed = await db.collection("deletion_requests").findOneAndUpdate(
      { _id: requestId, status: "pending" },
      {
        $set: {
          status: "approved",
          resolvedAt: new Date(),
          resolvedBy: req.user.id,
        },
      },
      { returnDocument: "after" },
    );
    if (!claimed) {
      const existing = await db
        .collection("deletion_requests")
        .findOne({ _id: requestId }, { projection: { _id: 1 } });
      sendApiError(
        res,
        existing ? 409 : 404,
        existing ? "DELETION_REQUEST_RESOLVED" : "DELETION_REQUEST_NOT_FOUND",
        existing
          ? "Deletion request has already been resolved."
          : "Deletion request not found.",
      );
      return;
    }
    const targetId = claimed.userId as ObjectId;
    const targetIdStr = targetId.toString();

    // Revoke all user sessions (Redis + Mongo); application routes already
    // return 401 because the middleware re-reads Mongo.
    await revokeUserSessions(targetIdStr);

    try {
      await deleteUserProfilePhotoForAccountDeletion(targetIdStr);
    } catch (error) {
      console.error(
        "Failed to delete profile photo during account deletion",
        error,
      );
      // Cleanup failed: restore the request to pending so an admin can retry
      // (fail closed — user data has not yet been deleted).
      await db.collection("deletion_requests").updateOne(
        { _id: requestId },
        {
          $set: { status: "pending" },
          $unset: { resolvedAt: "", resolvedBy: "" },
        },
      );
      sendApiError(
        res,
        503,
        "DELETION_CLEANUP_FAILED",
        "Profile photo could not be deleted from storage. Please try again.",
      );
      return;
    }

    try {
      await withGateUserLifecycleLock(
        targetIdStr,
        async (assertLifecycleOwned) => {
          await withRedisLock(
            subscriptionUserLockKey(targetIdStr),
            USER_LOCK_LEASE_MS,
            USER_LOCK_WAIT_MS,
            async (assertOwned) => {
              await assertOwned();
              await userCollection().deleteOne({ _id: targetId });
              await db.collection("account").deleteMany({ userId: targetId });
              await db
                .collection("subscriptions")
                .deleteMany({ userId: targetId });
              await db
                .collection("subscription_freezes")
                .deleteMany({ userId: targetId });
              await db.collection("twoFactor").deleteMany({ userId: targetId });
              // Reminder records reveal that an email was sent to this member on a date
              // and cannot remain tied to a member whose subscriptions were deleted under
              // the right to erasure. They have no statistical value, so delete them.
              await db
                .collection("renewal_reminders")
                .deleteMany({ userId: targetId });
              // Weight history is health data meaningful only with the member identity;
              // it has no statistical value to anonymize, so delete it completely.
              // Note: weight_history.userId is stored as a string, not an ObjectId.
              await weightHistoryCollection().deleteMany({
                userId: targetIdStr,
              });
              // Phase 6 sharing-detection records are also personal data (device
              // fingerprint, location drift). Retaining them for up to 30 days via TTL
              // conflicts with erasure, so approval removes them from storage and Redis.
              await db
                .collection("sharing_signals")
                .deleteMany({ userId: targetId });
              await redis.del([
                QR_LOC_KEY(targetIdStr),
                QR_BLOCK_KEY(targetIdStr),
                FP_CHURN_KEY(targetIdStr),
                `og:mfa-fail:${targetIdStr}`,
              ]);
              await markOutsideEverywhere(targetIdStr);
              await db
                .collection("entry_events")
                .updateMany(
                  { userId: targetIdStr, source: "reception" },
                  { $set: { staffReason: null } },
                );
              // Historical gate records are kept for statistics but must not contain
              // personal data.
              await db
                .collection("entry_events")
                .updateMany(
                  { userId: targetIdStr },
                  { $set: { userId: null, memberName: null } },
                );
              // Payments stay for the gym's financial records, but lose the link to the
              // person and their free text; cash reports keep adding up.
              await anonymisePaymentsForUser(targetIdStr);
            },
          );
          await assertLifecycleOwned();
          // Audit records must not retain the deleted member's email under the right
          // to erasure; action history remains anonymously linked through actorId.
          await db
            .collection("audit_logs")
            .updateMany(
              { actorId: targetIdStr },
              { $set: { actorEmail: null } },
            );

          // ALL of the user's requests, including earlier rejected ones, must lose
          // PII. This request's status/resolvedAt/resolvedBy fields were already set
          // during the atomic claim; only PII is cleared here.
          await db.collection("deletion_requests").updateMany(
            { userId: targetId },
            // `reason` is free text typed by staff about this member.
            { $set: { email: null, name: null, reason: null } },
          );
          // Ban and deletion-request reasons are free text about the member and sit
          // in audit rows targeting them; the rows stay (who did what, when) but the
          // text goes. The `ban` field itself lives on the user document, deleted
          // above.
          await db.collection("audit_logs").updateMany(
            {
              targetId: targetIdStr,
              action: {
                $in: [
                  "member-banned",
                  "member-unbanned",
                  "account-deletion-requested",
                  "payment-voided",
                ],
              },
            },
            { $unset: { "details.reason": "", "details.previousReason": "" } },
          );

          await db.collection("audit_logs").updateMany(
            {
              targetId: targetIdStr,
              action: { $in: ["gate-opened-by-staff", "gate-open-refused"] },
            },
            { $unset: { "details.staffReason": "" } },
          );

          // Remove the deleted user's PII from duplicate-phone conflict records; if
          // one account remains, migrate it to E.164 and delete the conflict record.
          await reconcilePhoneConflictsAfterUserChange(targetIdStr);

          await logAudit(req.user, "account-deletion-approved", targetIdStr);
        },
      );
    } catch (error) {
      if (!(error instanceof SubscriptionLockTimeoutError)) throw error;
      await db.collection("deletion_requests").updateOne(
        { _id: requestId },
        {
          $set: { status: "pending" },
          $unset: { resolvedAt: "", resolvedBy: "" },
        },
      );
      sendApiError(
        res,
        503,
        "SUBSCRIPTION_BUSY",
        "A subscription operation is in progress. Please try again.",
      );
      return;
    }
    res.json({ ok: true });
  }),
);

// Data protection: reject a deletion request
deletionRequestsRouter.post(
  "/deletion-requests/:id/reject",
  requireRole("owner"),
  authed(async (req, res) => {
    const requestId = toObjectId(String(req.params.id ?? ""));
    if (!requestId) {
      sendApiError(
        res,
        404,
        "DELETION_REQUEST_NOT_FOUND",
        "Deletion request not found.",
      );
      return;
    }
    const request = await db
      .collection("deletion_requests")
      .findOne({ _id: requestId });
    if (!request) {
      sendApiError(
        res,
        404,
        "DELETION_REQUEST_NOT_FOUND",
        "Deletion request not found.",
      );
      return;
    }
    if (request.status !== "pending") {
      sendApiError(
        res,
        409,
        "DELETION_REQUEST_RESOLVED",
        "Deletion request has already been resolved.",
      );
      return;
    }
    await db.collection("deletion_requests").updateOne(
      { _id: requestId },
      {
        $set: {
          status: "rejected",
          resolvedAt: new Date(),
          resolvedBy: req.user.id,
        },
      },
    );
    await logAudit(
      req.user,
      "account-deletion-rejected",
      (request.userId as ObjectId).toString(),
    );
    res.json({ ok: true });
  }),
);
