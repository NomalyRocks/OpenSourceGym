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
      /** Faz 6: BetterAuth oturum token'ı — cihaz kimliği fallback'i olarak kullanılır */
      sessionToken?: string;
    }
  }
}

/** requireRole'den geçmiş bir isteğin garanti alanları. */
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
 * requireRole'den SONRA gelen handler'ları sarar: gövdede `req.user` her
 * istekte doludur, bu yüzden non-null assertion gerekmez. Handler'ın dönüşü
 * aynen iletilir — Express 5 reject olan promise'i ancak böyle görüp hata
 * middleware'ine aktarabilir.
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
    // Session cache'i (Redis) rol/bayrak değişikliklerini geriden takip eder;
    // yetki kararları her istekte DB'deki güncel kayda göre verilir
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
    // US-2: zorunlu şifre değişimi yapılmadan yalnızca şifre değiştirme ve
    // profil uçları çalışır
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
