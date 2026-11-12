import { once } from "node:events";
import { Router, type Response } from "express";
import { ObjectId, type Document } from "mongodb";
import { z } from "zod";
import type {
  CashReport,
  ChainSummary,
  DebtorRow,
  EntryTrend,
  ExportDataset,
  Page,
  RenewalDueMember,
  RenewalReminderResult,
  ReportSummary,
} from "@opengym/shared";
import { sendApiError } from "../../core/apiError.js";
import { logAudit } from "../../core/audit.js";
import { csvRow, UTF8_BOM, entryCsvHeader, entryCsvValues } from "./csv.js";
import { db, toObjectId } from "../../core/db.js";
import {
  gymScoped,
  requireGymAccess,
  requireRole,
} from "../../core/middleware.js";
import { listAllGyms } from "../gyms/gyms.js";
import { InvalidCursorError, pageQuerySchema } from "../../lib/pagination.js";
import { env } from "../../core/env.js";
import { buildCashReport } from "../payments/cashReport.js";
import { listDebtors } from "../payments/debtors.js";
import {
  buildChainSummary,
  buildEntryTrend,
  buildReportSummary,
  isDayLabel,
  localDayLabel,
  MAX_REPORT_RANGE_DAYS,
} from "./reports.js";
import {
  findRenewalTarget,
  listRenewalsDue,
  MAX_RENEWAL_WINDOW_DAYS,
  remainingDays,
  sendRenewalReminder,
} from "./renewals.js";

/** Mounted at /api/admin/gyms/:gymId/reports — per-gym reports. */
export const gymReportsRouter: Router = Router({ mergeParams: true });

/** Mounted at /api/admin/reports — chain-level reports, owner only. */
export const chainReportsRouter: Router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;

const rangeQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

interface ResolvedRange {
  from: Date;
  to: Date;
}

/**
 * Resolves and bounds the range. The upper bound is required: without it, one
 * request scans years of data and the number of daily buckets locks the chart.
 */
function resolveRange(from?: Date, to?: Date): ResolvedRange | null {
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start > end ||
    end.getTime() - start.getTime() > MAX_REPORT_RANGE_DAYS * DAY_MS
  ) {
    return null;
  }
  return { from: start, to: end };
}

function parseRange(res: Response, query: unknown): ResolvedRange | null {
  const parsed = rangeQuerySchema.safeParse(query);
  const range = parsed.success
    ? resolveRange(parsed.data.from, parsed.data.to)
    : null;
  if (!range) {
    sendApiError(
      res,
      400,
      "INVALID_REPORT_RANGE",
      `Invalid report range. "from" must not be after "to" and the range must not exceed ${MAX_REPORT_RANGE_DAYS} days.`,
    );
    return null;
  }
  return range;
}

chainReportsRouter.get(
  "/chain/summary",
  requireRole("owner"),
  async (req, res) => {
    const range = parseRange(res, req.query);
    if (!range) return;
    const body: ChainSummary = await buildChainSummary(
      range,
      await listAllGyms(),
    );
    res.json(body);
  },
);

gymReportsRouter.get(
  "/summary",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const range = parseRange(res, req.query);
    if (!range) return;
    const body: ReportSummary = await buildReportSummary(
      range,
      req.gym._id.toHexString(),
    );
    res.json(body);
  }),
);

gymReportsRouter.get(
  "/entry-trend",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const range = parseRange(res, req.query);
    if (!range) return;
    const body: EntryTrend = await buildEntryTrend(
      range,
      req.gym._id.toHexString(),
    );
    res.json(body);
  }),
);

const renewalsQuerySchema = pageQuerySchema.extend({
  withinDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_RENEWAL_WINDOW_DAYS)
    .default(7),
});

gymReportsRouter.get(
  "/renewals",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const query = renewalsQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid list query parameters.",
      );
      return;
    }

    try {
      const page = await listRenewalsDue({
        ...query.data,
        gymId: req.gym._id.toHexString(),
      });
      const body: Page<RenewalDueMember> = {
        items: page.items,
        nextCursor: page.nextCursor,
      };
      res.json(body);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        sendApiError(res, 400, "INVALID_REQUEST", "Invalid pagination cursor.");
        return;
      }
      throw err;
    }
  }),
);

// Staff manually sends a reminder to one member.
gymReportsRouter.post(
  "/renewals/:userId/remind",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const gymId = req.gym._id.toHexString();
    const userId = toObjectId(String(req.params.userId ?? ""));
    if (!userId) {
      sendApiError(res, 400, "INVALID_USER", "Invalid user id.");
      return;
    }

    const target = await findRenewalTarget(userId, gymId);
    const now = new Date();
    if (!target || target.endsAt < now) {
      sendApiError(
        res,
        404,
        "NO_UPCOMING_RENEWAL",
        "This member has no upcoming subscription to remind about.",
      );
      return;
    }

    // The cooldown check runs under the same lock as sending; checking again
    // here would only duplicate work without closing the race.
    const outcome = await sendRenewalReminder({
      userId: target.userId,
      subscriptionId: target.subscriptionId,
      endsAt: target.endsAt,
      email: target.email,
      firstName: target.firstName,
      gymName: req.gym.name.trim() || "OpenGym",
      thresholdDays: null,
      automatic: false,
      sentBy: req.user.email,
      now,
    });

    // "busy" and "already-sent" mean the same to the client: no email was sent
    // now because this subscription was handled moments ago.
    if (outcome.status !== "sent") {
      sendApiError(
        res,
        429,
        "REMINDER_RECENTLY_SENT",
        "This member was reminded recently. Try again later.",
      );
      return;
    }

    await logAudit(
      req.user,
      "renewal-reminder-sent",
      target.userId.toString(),
      {
        remainingDays: remainingDays(target.endsAt, now),
      },
      gymId,
    );

    const body: RenewalReminderResult = {
      sent: true,
      sentAt: outcome.sentAt.toISOString(),
    };
    res.json(body);
  }),
);

const cashQuerySchema = z.object({
  day: z
    .string()
    .refine(isDayLabel, "Expected a calendar day as YYYY-MM-DD")
    .optional(),
});

// Money taken at this gym during one local day. Owner/admin only: staff record
// payments but do not see the till.
gymReportsRouter.get(
  "/cash",
  requireGymAccess("owner", "admin"),
  gymScoped(async (req, res) => {
    const query = cashQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(
        res,
        400,
        "INVALID_DAY",
        "Day must be a calendar date as YYYY-MM-DD.",
      );
      return;
    }
    const day =
      query.data.day ?? localDayLabel(new Date(), env.reportsTimeZone);
    const body: CashReport = await buildCashReport(
      req.gym._id.toHexString(),
      day,
      env.reportsTimeZone,
    );
    res.json(body);
  }),
);

// Periods that still owe money. Staff chase balances at the desk, so they see
// this list too.
gymReportsRouter.get(
  "/debtors",
  requireGymAccess("owner", "admin", "staff"),
  gymScoped(async (req, res) => {
    const query = pageQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid list query parameters.",
      );
      return;
    }
    try {
      const page = await listDebtors({
        ...query.data,
        gymId: req.gym._id.toHexString(),
      });
      const body: Page<DebtorRow> = {
        items: page.items,
        nextCursor: page.nextCursor,
      };
      res.json(body);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        sendApiError(res, 400, "INVALID_REQUEST", "Invalid pagination cursor.");
        return;
      }
      throw err;
    }
  }),
);

const exportQuerySchema = rangeQuerySchema.extend({
  dataset: z.enum(["members", "subscriptions", "entries", "payments"]),
});

interface ExportSpec {
  collection: string;
  header: string[];
  pipeline: (range: ResolvedRange, gymId: string) => Document[];
  row: (doc: Document) => unknown[];
}

const EXPORTS: Record<ExportDataset, ExportSpec> = {
  members: {
    collection: "user",
    header: [
      "id",
      "firstName",
      "lastName",
      "email",
      "phone",
      "role",
      "createdAt",
    ],
    // Accounts are chain-wide; a gym's export holds the members registered in
    // the range who hold a subscription period for that gym.
    pipeline: ({ from, to }, gymId) => [
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $lookup: {
          from: "subscriptions",
          let: { userId: "$_id" },
          pipeline: [
            {
              $match: {
                gymIds: new ObjectId(gymId),
                $expr: { $eq: ["$userId", "$$userId"] },
              },
            },
            { $limit: 1 },
          ],
          as: "gymSubscriptions",
        },
      },
      { $match: { "gymSubscriptions.0": { $exists: true } } },
      { $sort: { createdAt: 1, _id: 1 } },
    ],
    row: (doc) => [
      doc._id,
      doc.firstName,
      doc.lastName,
      doc.email,
      doc.phone,
      doc.role,
      doc.createdAt,
    ],
  },
  subscriptions: {
    collection: "subscriptions",
    header: [
      "id",
      "memberEmail",
      "memberName",
      "gymIds",
      "startsAt",
      "endsAt",
      "note",
      "createdBy",
      "createdAt",
    ],
    pipeline: ({ from, to }, gymId) => [
      {
        $match: {
          gymIds: new ObjectId(gymId),
          createdAt: { $gte: from, $lte: to },
        },
      },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $lookup: {
          from: "user",
          localField: "userId",
          foreignField: "_id",
          as: "userDocs",
        },
      },
      { $addFields: { member: { $first: "$userDocs" } } },
    ],
    row: (doc) => [
      doc._id,
      doc.member?.email,
      [doc.member?.firstName, doc.member?.lastName].filter(Boolean).join(" "),
      ((doc.gymIds as unknown[] | undefined) ?? []).join(" "),
      doc.startsAt,
      doc.endsAt,
      doc.note,
      doc.createdBy,
      doc.createdAt,
    ],
  },
  payments: {
    collection: "payments",
    header: [
      "id",
      "gymId",
      "paidAt",
      "memberEmail",
      "memberName",
      "packageName",
      "amountMinor",
      "currency",
      "method",
      "recordedBy",
      "note",
      "voidedAt",
      "voidedBy",
      "voidReason",
    ],
    // Payments recorded at this gym in the range, voided ones included and
    // marked. Anonymised rows (deleted members) have no member columns.
    pipeline: ({ from, to }, gymId) => [
      { $match: { gymId, paidAt: { $gte: from, $lte: to } } },
      { $sort: { paidAt: 1, _id: 1 } },
      {
        $lookup: {
          from: "user",
          let: { memberId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: ["$$memberId", null] },
                    { $eq: [{ $toString: "$_id" }, "$$memberId"] },
                  ],
                },
              },
            },
            { $project: { email: 1, firstName: 1, lastName: 1 } },
          ],
          as: "userDocs",
        },
      },
      { $addFields: { member: { $first: "$userDocs" } } },
    ],
    row: (doc) => [
      doc._id,
      doc.gymId,
      doc.paidAt,
      doc.member?.email,
      [doc.member?.firstName, doc.member?.lastName].filter(Boolean).join(" "),
      doc.packageName,
      doc.amountMinor,
      doc.currency,
      doc.method,
      doc.recordedBy,
      doc.note,
      doc.void?.at,
      doc.void?.by,
      doc.void?.reason,
    ],
  },
  entries: {
    collection: "entry_events",
    header: entryCsvHeader,
    pipeline: ({ from, to }, gymId) => [
      { $match: { gymId, at: { $gte: from, $lte: to } } },
      { $sort: { at: 1, _id: 1 } },
    ],
    row: entryCsvValues,
  },
};

/**
 * Honors stream backpressure to avoid memory growth with slow clients. If the
 * client disconnects, `drain` never arrives, so waiting is aborted on `close`.
 */
async function writeChunk(
  res: Response,
  chunk: string,
  signal: AbortSignal,
): Promise<void> {
  if (res.write(chunk)) return;
  await once(res, "drain", { signal });
}

// Exports produce bulk PERSONAL DATA: admin only, with every download audited.
gymReportsRouter.get(
  "/export",
  requireGymAccess("owner", "admin"),
  gymScoped(async (req, res) => {
    const gymId = req.gym._id.toHexString();
    const parsed = exportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_REQUEST", "Invalid export parameters.");
      return;
    }
    const range = resolveRange(parsed.data.from, parsed.data.to);
    if (!range) {
      sendApiError(
        res,
        400,
        "INVALID_REPORT_RANGE",
        `Invalid report range. "from" must not be after "to" and the range must not exceed ${MAX_REPORT_RANGE_DAYS} days.`,
      );
      return;
    }

    const dataset = parsed.data.dataset;
    const spec = EXPORTS[dataset];
    const stamp = range.to.toISOString().slice(0, 10);

    await logAudit(
      req.user,
      "data-exported",
      undefined,
      {
        dataset,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
      gymId,
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="opengym-${gymId}-${dataset}-${stamp}.csv"`,
    );
    // An export is a snapshot and must not be cached.
    res.setHeader("Cache-Control", "no-store");

    const controller = new AbortController();
    res.on("close", () => controller.abort());

    const cursor = db
      .collection(spec.collection)
      .aggregate<Document>(spec.pipeline(range, gymId));

    try {
      await writeChunk(res, UTF8_BOM + csvRow(spec.header), controller.signal);
      for await (const doc of cursor) {
        await writeChunk(res, csvRow(spec.row(doc)), controller.signal);
      }
      res.end();
    } catch (err) {
      await cursor.close().catch(() => {});
      // A JSON error body cannot be written after headers are sent; closing the
      // connection is the only way to tell the client the file is incomplete.
      if (controller.signal.aborted) return;
      console.error("Export stream failed:", err);
      res.destroy();
    }
  }),
);
