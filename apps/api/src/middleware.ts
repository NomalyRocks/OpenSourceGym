import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import type { MyProfile, Role } from "@opengym/shared";
import { auth } from "./auth.js";
import { sendApiError } from "./apiError.js";
import { userCollection } from "./db.js";
import { buildProfilePhotoUrl } from "./profilePhoto.js";
import { findGym, type GymDoc } from "./gyms.js";

export type SessionUser = MyProfile;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      /** Phase 6: BetterAuth session token—used as a device-identity fallback */
      sessionToken?: string;
      /** Set by requireGymAccess: the gym addressed by the path */
      gym?: GymDoc;
    }
  }
}

/** Guaranteed fields on a request that has passed requireRole. */
export interface AuthedRequest extends Request {
  user: SessionUser;
  sessionToken: string;
}

/** Guaranteed fields on a request that has passed requireGymAccess. */
export interface GymRequest extends AuthedRequest {
  gym: GymDoc;
}

export type AuthedHandler = (
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

/**
 * Wraps handlers that run AFTER requireRole: `req.user` is populated on every
 * request, so no non-null assertion is needed. The handler return value is
 * forwarded unchanged—only then can Express 5 observe a rejected promise and
 * pass it to error middleware.
 */
export function authed(handler: AuthedHandler): RequestHandler {
  return (req, res, next) => handler(req as AuthedRequest, res, next);
}

export type GymHandler = (
  req: GymRequest,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

/** Like {@link authed}, for handlers behind requireGymAccess. */
export function gymScoped(handler: GymHandler): RequestHandler {
  return (req, res, next) => handler(req as GymRequest, res, next);
}

/**
 * Resolves the session and re-reads the user from Mongo. Returns null after
 * sending the 401 response.
 */
async function loadSessionUser(
  req: Request,
  res: Response,
): Promise<SessionUser | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session) {
    sendApiError(res, 401, "AUTH_REQUIRED", "Authentication required.");
    return null;
  }
  req.sessionToken = session.session.token;
  // The session cache (Redis) lags behind role and flag changes; authorization
  // decisions use the current database record on every request
  const doc = await userCollection().findOne({
    _id: new ObjectId(session.user.id),
  });
  if (!doc) {
    sendApiError(res, 401, "AUTH_REQUIRED", "Authentication required.");
    return null;
  }
  const role = doc.role ?? "member";
  return {
    id: session.user.id,
    email: doc.email,
    name: doc.name,
    role,
    // Scope is only meaningful for admin/staff; never trust a stale value on
    // any other role.
    gymIds: role === "admin" || role === "staff" ? (doc.gymIds ?? []) : [],
    mustChangePassword: doc.mustChangePassword ?? false,
    twoFactorEnabled: doc.twoFactorEnabled ?? false,
    profilePhotoUrl: buildProfilePhotoUrl(
      doc.profilePhotoKey,
      doc.profilePhotoUpdatedAt,
    ),
    age: typeof doc.age === "number" ? doc.age : null,
    heightCm: typeof doc.heightCm === "number" ? doc.heightCm : null,
    weightKg: typeof doc.weightKg === "number" ? doc.weightKg : null,
  };
}

/**
 * Role and password-change gates shared by requireRole and requireGymAccess.
 * Returns false after sending the error response.
 */
function passesRoleGates(
  user: SessionUser,
  roles: Role[],
  req: Request,
  res: Response,
): boolean {
  if (!roles.includes(user.role)) {
    sendApiError(
      res,
      403,
      "FORBIDDEN",
      "You are not authorized to perform this action.",
    );
    return false;
  }
  // US-2: only password-change and profile endpoints work before the required
  // password change
  const exemptPaths = ["/initial-password", "/profile"];
  if (user.mustChangePassword && !exemptPaths.includes(req.path)) {
    sendApiError(
      res,
      403,
      "PASSWORD_CHANGE_REQUIRED",
      "You must change your password before continuing.",
    );
    return false;
  }
  return true;
}

export function requireRole(...roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = await loadSessionUser(req, res);
    if (!user || !passesRoleGates(user, roles, req, res)) return;
    req.user = user;
    next();
  };
}

/**
 * Gym-scoped routes (`/api/admin/gyms/:gymId/...`): same session check and
 * Mongo re-read as requireRole, then the path's gym must exist and be inside
 * the caller's scope. `owner` passes for every gym (when listed in `roles`);
 * admin/staff only for gyms in their re-read `gymIds`. The gym is never
 * inferred from a header.
 *
 * Mount on a router created with `mergeParams: true` so `:gymId` is visible.
 */
export function requireGymAccess(...roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = await loadSessionUser(req, res);
    if (!user || !passesRoleGates(user, roles, req, res)) return;
    const gymId = String(req.params.gymId ?? "");
    // Out-of-scope callers get 403 whether or not the gym exists, so gym ids
    // cannot be probed.
    if (user.role !== "owner" && !user.gymIds.includes(gymId)) {
      sendApiError(
        res,
        403,
        "GYM_OUT_OF_SCOPE",
        "This gym is outside your scope.",
      );
      return;
    }
    const gym = await findGym(gymId);
    if (!gym) {
      sendApiError(res, 404, "GYM_NOT_FOUND", "Gym not found.");
      return;
    }
    req.user = user;
    req.gym = gym;
    next();
  };
}
