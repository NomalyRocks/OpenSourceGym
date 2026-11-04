import { Router } from "express";
import type { Document, WithId } from "mongodb";
import { z } from "zod";
import type { AuditLogEntry, Page } from "@opengym/shared";
import { sendApiError } from "../../core/apiError.js";
import { db } from "../../core/db.js";
import { authed, requireRole } from "../../core/middleware.js";
import {
  dateRangeFilter,
  findPage,
  pageQuerySchema,
  toInvalidCursorResponse,
} from "../../lib/pagination.js";

export const auditRouter: Router = Router();

/** Audit row → API shape (shared by the chain and per-gym audit viewers). */
export function toAuditLogEntry(d: WithId<Document>): AuditLogEntry {
  return {
    id: d._id.toString(),
    actorId: d.actorId,
    actorEmail: d.actorEmail,
    action: d.action,
    targetId: d.targetId ?? undefined,
    details: d.details ?? undefined,
    at: (d.at as Date).toISOString(),
    gymId: d.gymId ?? null,
  };
}

const auditQuerySchema = pageQuerySchema.extend({
  action: z.string().min(1).max(64).optional(),
  gymId: z.string().min(1).max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Audit log viewer — cursor pagination + action/gym/date filters. Owner sees
// everything; an admin sees only rows whose gymId is in their scope (chain-level
// rows are hidden).
auditRouter.get(
  "/audit",
  requireRole("owner", "admin"),
  authed(async (req, res) => {
    const query = auditQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid list query parameters.",
      );
      return;
    }
    const { cursor, limit, action, gymId, from, to } = query.data;

    const filters: Record<string, unknown>[] = [];
    if (action) filters.push({ action });
    if (req.user.role === "owner") {
      if (gymId) filters.push({ gymId });
    } else if (gymId) {
      if (!req.user.gymIds.includes(gymId)) {
        sendApiError(
          res,
          403,
          "GYM_OUT_OF_SCOPE",
          "This gym is outside your scope.",
        );
        return;
      }
      filters.push({ gymId });
    } else {
      filters.push({ gymId: { $in: req.user.gymIds } });
    }
    const range = dateRangeFilter("at", from, to);
    if (Object.keys(range).length > 0) filters.push(range);

    const page = await findPage(db.collection("audit_logs"), {
      timeField: "at",
      filter: filters.length > 0 ? { $and: filters } : {},
      cursor,
      limit,
    }).catch(toInvalidCursorResponse(res));
    if (!page) return;

    const body: Page<AuditLogEntry> = {
      items: page.docs.map(toAuditLogEntry),
      nextCursor: page.nextCursor,
    };
    res.json(body);
  }),
);
