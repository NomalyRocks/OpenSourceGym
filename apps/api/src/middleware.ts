import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import type { MyProfile, Role } from "@opengym/shared";
import { auth } from "./auth.js";
import { sendApiError } from "./apiError.js";
import { userCollection } from "./db.js";
import { buildProfilePhotoUrl } from "./profilePhoto.js";

export type SessionUser = MyProfile;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      /** Phase 6: BetterAuth session token—used as a device-identity fallback */
      sessionToken?: string;
    }
  }
}

/** Guaranteed fields on a request that has passed requireRole. */
export interface AuthedRequest extends Request {
  user: SessionUser;
  sessionToken: string;
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

export function requireRole(...roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      sendApiError(res, 401, "AUTH_REQUIRED", "Authentication required.");
      return;
    }
    req.sessionToken = session.session.token;
    // The session cache (Redis) lags behind role and flag changes; authorization
    // decisions use the current database record on every request
    const doc = await userCollection().findOne({
      _id: new ObjectId(session.user.id),
    });
    if (!doc) {
      sendApiError(res, 401, "AUTH_REQUIRED", "Authentication required.");
      return;
    }
    const user: SessionUser = {
      id: session.user.id,
      email: doc.email,
      name: doc.name,
      role: doc.role ?? "member",
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
    if (!roles.includes(user.role)) {
      sendApiError(
        res,
        403,
        "FORBIDDEN",
        "You are not authorized to perform this action.",
      );
      return;
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
      return;
    }
    req.user = user;
    next();
  };
}
