import { type Db, type Document, ObjectId } from "mongodb";
import { z } from "zod";
import type {
  InactiveMemberRow,
  LapsedMemberRow,
  LostMembersPage,
} from "@opengym/shared";
import { db } from "../../core/db.js";
import {
  cursorFilter,
  decodeCursor,
  InvalidCursorError,
  pageQuerySchema,
  sortSpec,
  toPage,
} from "../../lib/pagination.js";
import { excludeFrozenMembersStages } from "../freeze/frozenMembers.js";
import {
  gymScopeStages,
  lapsedMembersStages,
  type ReportRangeInput,
} from "./reports.js";

const DAY_MS = 86_400_000;
// A date before every possible visit keeps never-visited rows first and lets
// them share the standard time/id cursor with dated rows.
const NEVER_VISITED = new Date(-8_640_000_000_000_000);

export const inactiveDaysSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(365)
  .default(14);
export const lostMembersQuerySchema = pageQuerySchema
  .extend({
    page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  })
  .refine((query) => !(query.cursor && query.page), {
    message: "Use either page or cursor pagination.",
  });
export const inactiveMembersQuerySchema = lostMembersQuerySchema.safeExtend({
  days: inactiveDaysSchema,
});

/** Event user ids are strings, whereas subscription user ids are ObjectIds. */
function memberDetailsStages(gymId: string): Document[] {
  return [
    {
      $lookup: {
        from: "user",
        localField: "_id",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              name: 1,
              firstName: 1,
              lastName: 1,
              email: 1,
              phone: 1,
              role: 1,
            },
          },
        ],
        as: "users",
      },
    },
    { $set: { member: { $first: "$users" } } },
    {
      $lookup: {
        from: "entry_events",
        let: { memberId: { $toString: "$_id" } },
        pipeline: [
          {
            $match: {
              gymId,
              userId: { $ne: null },
              allowed: true,
              direction: "in",
              $expr: { $eq: ["$userId", "$$memberId"] },
            },
          },
          { $sort: { at: -1 } },
          { $limit: 1 },
          { $project: { at: 1 } },
        ],
        as: "visits",
      },
    },
    { $set: { lastEntryAt: { $ifNull: [{ $first: "$visits.at" }, null] } } },
    { $unset: ["users", "visits"] },
  ];
}

export async function inactiveMembersPipeline(
  gymId: string,
  days: number,
  now = new Date(),
  database: Db = db,
): Promise<Document[]> {
  return [
    ...(await excludeFrozenMembersStages(database)),
    ...gymScopeStages(gymId),
    { $match: { startsAt: { $lte: now }, endsAt: { $gte: now } } },
    { $group: { _id: "$userId", periodEndsAt: { $max: "$endsAt" } } },
    ...memberDetailsStages(gymId),
    {
      $match: {
        "member.role": "member",
        $or: [
          { lastEntryAt: null },
          { lastEntryAt: { $lt: new Date(now.getTime() - days * DAY_MS) } },
        ],
      },
    },
    { $set: { sortAt: { $ifNull: ["$lastEntryAt", NEVER_VISITED] } } },
    { $sort: sortSpec("sortAt", "asc") },
  ];
}

export async function lapsedMembersPipeline(
  range: ReportRangeInput,
  gymId: string,
  database: Db = db,
): Promise<Document[]> {
  return [
    ...(await lapsedMembersStages(range, gymId, database)),
    ...memberDetailsStages(gymId),
    { $set: { sortAt: "$latestEnd" } },
    { $sort: sortSpec("sortAt") },
  ];
}

interface LostMemberDocument extends Document {
  _id: ObjectId;
  sortAt: Date;
  lastEntryAt: Date | null;
  periodEndsAt: Date;
  latestEnd: Date;
  member?: {
    name?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
}

function identity(row: LostMemberDocument) {
  return {
    userId: row._id.toHexString(),
    name:
      [row.member?.firstName, row.member?.lastName].filter(Boolean).join(" ") ||
      row.member?.name ||
      "",
    email: row.member?.email ?? "",
    phone: row.member?.phone ?? "",
    lastEntryAt: row.lastEntryAt?.toISOString() ?? null,
  };
}

export function inactiveMemberRow(
  row: LostMemberDocument,
  now: Date,
): InactiveMemberRow {
  return {
    ...identity(row),
    daysSinceLastEntry: row.lastEntryAt
      ? Math.floor((now.getTime() - row.lastEntryAt.getTime()) / DAY_MS)
      : null,
    periodEndsAt: row.periodEndsAt.toISOString(),
  };
}

export function lapsedMemberRow(row: LostMemberDocument): LapsedMemberRow {
  return { ...identity(row), endedAt: row.latestEnd.toISOString() };
}

interface ListParams {
  gymId: string;
  limit: number;
  cursor?: string | undefined;
  page?: number | undefined;
}

async function listPage<T>(
  pipeline: Document[],
  params: ListParams,
  direction: "asc" | "desc",
  map: (row: LostMemberDocument) => T,
  database: Db,
): Promise<LostMembersPage<T>> {
  const cursor = params.cursor ? decodeCursor(params.cursor) : null;
  if (params.cursor && !cursor) throw new InvalidCursorError();
  const [result] = await database
    .collection("subscriptions")
    .aggregate<{
      items: LostMemberDocument[];
      total: { n: number }[];
    }>([
      ...pipeline,
      {
        $facet: {
          total: [{ $count: "n" }],
          items: [
            ...(cursor
              ? [{ $match: cursorFilter("sortAt", cursor, direction) }]
              : []),
            ...(params.page
              ? [{ $skip: (params.page - 1) * params.limit }]
              : []),
            { $limit: params.limit + 1 },
          ],
        },
      },
    ])
    .toArray();
  const page = toPage(result?.items ?? [], "sortAt", params.limit);
  return {
    items: (page.docs as LostMemberDocument[]).map(map),
    nextCursor: page.nextCursor,
    total: result?.total[0]?.n ?? 0,
  };
}

export async function listInactiveMembers(
  params: ListParams & { days: number; now?: Date },
  database: Db = db,
): Promise<LostMembersPage<InactiveMemberRow>> {
  const now = params.now ?? new Date();
  return listPage(
    await inactiveMembersPipeline(params.gymId, params.days, now, database),
    params,
    "asc",
    (row) => inactiveMemberRow(row, now),
    database,
  );
}

export async function listLapsedMembers(
  params: ListParams & ReportRangeInput,
  database: Db = db,
): Promise<LostMembersPage<LapsedMemberRow>> {
  return listPage(
    await lapsedMembersPipeline(params, params.gymId, database),
    params,
    "desc",
    lapsedMemberRow,
    database,
  );
}
