import type { Document, Filter, ObjectId } from "mongodb";

export const USER_SEARCH_LIMIT = 20;

export function parseUserSearchQuery(value: unknown): string | null {
  const query = typeof value === "string" ? value.trim() : "";
  return query.length >= 2 ? query : null;
}

export function tokenizeUserSearchQuery(query: string): string[] {
  return query.trim().split(/\s+/u).filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPatterns(term: string): RegExp[] {
  const values = new Set([term]);
  const digits = term.replace(/\D/gu, "");
  const looksLikePhone = /^[+\d().-]+$/u.test(term);
  if (looksLikePhone && digits && digits !== term) values.add(digits);
  return [...values].map((value) => new RegExp(escapeRegex(value), "i"));
}

/**
 * Every query term must match at least one user field. This allows terms in a
 * query such as "Alice Smith" to be satisfied by different fields.
 */
export function buildUserSearchFilter(
  query: string,
  conflictUserIds: readonly ObjectId[] = [],
): Filter<Document> {
  const terms = tokenizeUserSearchQuery(query);

  const fieldFilter: Filter<Document> = {
    $and: terms.map((term) => {
      const patterns = termPatterns(term);
      const textPattern = patterns[0]!;
      const phoneClauses = patterns.flatMap((pattern) => [
        { phone: pattern },
        { phoneE164: pattern },
      ]);

      return {
        $or: [
          { firstName: textPattern },
          { lastName: textPattern },
          { name: textPattern },
          { email: textPattern },
          ...phoneClauses,
          {
            $expr: {
              $regexMatch: {
                input: {
                  $concat: [
                    { $ifNull: ["$firstName", ""] },
                    " ",
                    { $ifNull: ["$lastName", ""] },
                  ],
                },
                regex: escapeRegex(term),
                options: "i",
              },
            },
          },
        ],
      };
    }),
  };

  if (conflictUserIds.length === 0) return fieldFilter;
  return {
    $or: [fieldFilter, { _id: { $in: [...conflictUserIds] } }],
  };
}
