import { ObjectId, type Document } from "mongodb";
import { z } from "zod";
import type { SubscriptionStatus } from "@opengym/shared";

export const DIRECTORY_DEFAULT_PAGE_SIZE = 25;
export const DIRECTORY_MAX_PAGE_SIZE = 100;

const ROLES = ["owner", "admin", "staff", "member"] as const;
const STATUSES = ["active", "frozen", "expired", "none"] as const;

/** Comma-separated query value → deduplicated list validated against `values`. */
function csvEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .transform((raw) => [
      ...new Set(
        raw
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.enum(values)))
    .transform((list) => (list.length > 0 ? list : undefined));
}

export const userDirectoryQuerySchema = z.object({
  q: z.string().optional(),
  role: csvEnum(ROLES).optional(),
  twoFactor: z.enum(["on", "off"]).optional(),
  status: csvEnum(STATUSES).optional(),
  gymId: z
    .string()
    .regex(/^[a-f\d]{24}$/i)
    .optional(),
  sort: z.enum(["name", "createdAt"]).default("createdAt"),
  dir: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(DIRECTORY_MAX_PAGE_SIZE)
    .default(DIRECTORY_DEFAULT_PAGE_SIZE),
});

export type UserDirectoryQuery = z.infer<typeof userDirectoryQuerySchema>;

/** Name sorts ascending by default; createdAt sorts newest first. */
export function resolveDirectorySort(
  query: Pick<UserDirectoryQuery, "sort" | "dir">,
): { direction: 1 | -1; spec: Document } {
  const direction =
    (query.dir ?? (query.sort === "name" ? "asc" : "desc")) === "asc" ? 1 : -1;
  const spec: Document =
    query.sort === "name"
      ? { firstName: direction, lastName: direction, _id: direction }
      : { createdAt: direction, _id: direction };
  return { direction, spec };
}

/** User-level conditions (everything answerable without the subscriptions). */
export function buildDirectoryUserMatch(
  query: Pick<UserDirectoryQuery, "role" | "twoFactor">,
  searchFilter: Document | null,
): Document {
  const clauses: Document[] = [];
  if (searchFilter) clauses.push(searchFilter);
  if (query.role) clauses.push({ role: { $in: query.role } });
  if (query.twoFactor === "on") clauses.push({ twoFactorEnabled: true });
  // A user without the field has never enabled MFA.
  if (query.twoFactor === "off") {
    clauses.push({ twoFactorEnabled: { $ne: true } });
  }
  return clauses.length > 0 ? { $and: clauses } : {};
}

/** Whether the filters need subscription facts before sorting and paging. */
export function directoryNeedsSubscriptionFilter(
  query: Pick<UserDirectoryQuery, "status" | "gymId">,
): boolean {
  return query.status !== undefined || query.gymId !== undefined;
}

const SUBSCRIPTION_STAGES = (now: Date): Document[] => [
  {
    // Periods that already started; future periods do not affect the status.
    $lookup: {
      from: "subscriptions",
      localField: "_id",
      foreignField: "userId",
      pipeline: [
        { $match: { startsAt: { $lte: now } } },
        { $project: { _id: 0, endsAt: 1, gymIds: 1 } },
      ],
      as: "_subs",
    },
  },
  {
    // At most one open freeze per member (unique partial index).
    $lookup: {
      from: "subscription_freezes",
      localField: "_id",
      foreignField: "userId",
      pipeline: [
        { $match: { endedAt: null } },
        { $limit: 1 },
        { $project: { _id: 1 } },
      ],
      as: "_openFreeze",
    },
  },
  {
    $addFields: {
      _activeSubs: {
        $filter: {
          input: "$_subs",
          as: "s",
          cond: { $gt: ["$$s.endsAt", now] },
        },
      },
      _frozen: { $gt: [{ $size: "$_openFreeze" }, 0] },
    },
  },
  {
    // The periods a member "belongs to" for the gym filter and the gym list:
    // the active ones, or - for a frozen member whose nominal end has passed
    // during the freeze - the latest started period(s), so the member stays
    // visible to their gym while paused.
    $addFields: {
      _gymSubs: {
        $cond: [
          {
            $and: ["$_frozen", { $eq: [{ $size: "$_activeSubs" }, 0] }],
          },
          {
            $filter: {
              input: "$_subs",
              as: "s",
              cond: { $eq: ["$$s.endsAt", { $max: "$_subs.endsAt" }] },
            },
          },
          "$_activeSubs",
        ],
      },
    },
  },
  {
    $addFields: {
      subscriptionStatus: {
        $switch: {
          branches: [
            // Frozen wins over active AND expired.
            {
              case: {
                $and: ["$_frozen", { $gt: [{ $size: "$_subs" }, 0] }],
              },
              then: "frozen",
            },
            { case: { $gt: [{ $size: "$_activeSubs" }, 0] }, then: "active" },
            { case: { $gt: [{ $size: "$_subs" }, 0] }, then: "expired" },
          ],
          default: "none",
        },
      },
      // Union of the gyms of every currently active period, as hex strings.
      subscriptionGymIds: {
        $map: {
          input: {
            $reduce: {
              input: "$_gymSubs.gymIds",
              initialValue: [],
              in: { $setUnion: ["$$value", { $ifNull: ["$$this", []] }] },
            },
          },
          as: "g",
          in: { $toString: "$$g" },
        },
      },
      // Latest end among the started periods: the current one when active, the
      // latest past one when expired, the nominal end when frozen.
      subscriptionEndsAt: { $max: "$_subs.endsAt" },
    },
  },
];

const CLEANUP_STAGE: Document = {
  $project: {
    _subs: 0,
    _activeSubs: 0,
    _gymSubs: 0,
    _openFreeze: 0,
    _frozen: 0,
  },
};

function gymMatch(gymId: string): Document {
  const gymOid = new ObjectId(gymId);
  return {
    $or: [
      { role: { $in: ["admin", "staff"] }, gymIds: gymId },
      {
        role: "member",
        $expr: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: "$_gymSubs",
                  as: "s",
                  cond: { $in: [gymOid, { $ifNull: ["$$s.gymIds", []] }] },
                },
              },
            },
            0,
          ],
        },
      },
    ],
  };
}

export interface DirectoryPlan {
  /** Pipeline returning `{ total: [{ n }], items: [...] }`. */
  pipeline: Document[];
  /** `name` sorts need a Turkish collation (ç, ğ, ı, ö, ş, ü). */
  collation: { locale: string } | undefined;
}

/**
 * Builds the single aggregation behind the directory. When only user-level
 * filters apply, the page is cut before the subscriptions are joined so the
 * `$lookup` runs for one page, not for every matching user; the status and gym
 * filters need the join first.
 */
export function buildDirectoryPlan(
  query: UserDirectoryQuery,
  userMatch: Document,
  now: Date,
): DirectoryPlan {
  const { spec } = resolveDirectorySort(query);
  const skip = (query.page - 1) * query.pageSize;
  const collation = query.sort === "name" ? { locale: "tr" } : undefined;

  if (!directoryNeedsSubscriptionFilter(query)) {
    return {
      collation,
      pipeline: [
        { $match: userMatch },
        {
          $facet: {
            total: [{ $count: "n" }],
            items: [
              { $sort: spec },
              { $skip: skip },
              { $limit: query.pageSize },
              ...SUBSCRIPTION_STAGES(now),
              CLEANUP_STAGE,
            ],
          },
        },
      ],
    };
  }

  const filters: Document[] = [];
  if (query.status) {
    filters.push({ subscriptionStatus: { $in: query.status } });
  }
  if (query.gymId) filters.push(gymMatch(query.gymId));
  return {
    collation,
    pipeline: [
      { $match: userMatch },
      ...SUBSCRIPTION_STAGES(now),
      { $match: { $and: filters } },
      {
        $facet: {
          total: [{ $count: "n" }],
          items: [
            { $sort: spec },
            { $skip: skip },
            { $limit: query.pageSize },
            CLEANUP_STAGE,
          ],
        },
      },
    ],
  };
}

export interface DirectoryRowExtras {
  subscriptionStatus: SubscriptionStatus;
  subscriptionEndsAt: Date | null;
}
