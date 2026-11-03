import express, { Router } from "express";
import type { ProfilePhotoResponse } from "@opengym/shared";
import { sendApiError } from "../../core/apiError.js";
import { authed, requireRole } from "../../core/middleware.js";
import { logAudit } from "../../core/audit.js";
import {
  ProfilePhotoBusyError,
  ProfilePhotoConfigError,
  ProfilePhotoInputError,
  ProfilePhotoRateLimitError,
  removeUserProfilePhoto,
  storeUserProfilePhoto,
} from "../profilePhoto/profilePhoto.js";

export const profileRouter: Router = Router();

// Current profile of the signed-in user (role/flags are read fresh from the DB)
profileRouter.get(
  "/profile",
  requireRole("owner", "admin", "staff", "member"),
  authed((req, res) => {
    res.json(req.user);
  }),
);

// Member's own profile photo: the API normalizes the image and writes it to R2.
profileRouter.put(
  "/profile-photo",
  requireRole("member"),
  express.raw({ type: "*/*", limit: "10mb" }),
  authed(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      sendApiError(
        res,
        400,
        "PROFILE_PHOTO_MISSING",
        "No photo data was provided.",
      );
      return;
    }
    try {
      const profilePhotoUrl = await storeUserProfilePhoto(
        req.user.id,
        req.body,
        req.header("content-type") ?? "",
      );
      await logAudit(req.user, "profile-photo-updated", req.user.id);
      const body: ProfilePhotoResponse = { profilePhotoUrl };
      res.json(body);
    } catch (error) {
      if (error instanceof ProfilePhotoInputError) {
        sendApiError(res, 400, "PROFILE_PHOTO_INVALID", error.message);
        return;
      }
      if (error instanceof ProfilePhotoBusyError) {
        sendApiError(res, 409, "PROFILE_PHOTO_BUSY", error.message);
        return;
      }
      if (error instanceof ProfilePhotoRateLimitError) {
        sendApiError(res, 429, "PROFILE_PHOTO_RATE_LIMITED", error.message);
        return;
      }
      if (error instanceof ProfilePhotoConfigError) {
        sendApiError(res, 503, "PROFILE_PHOTO_UNAVAILABLE", error.message);
        return;
      }
      console.error("Failed to upload profile photo", error);
      sendApiError(
        res,
        503,
        "PROFILE_PHOTO_UNAVAILABLE",
        "Profile photo could not be uploaded. Please try again.",
      );
    }
  }),
);

profileRouter.delete(
  "/profile-photo",
  requireRole("member"),
  authed(async (req, res) => {
    try {
      await removeUserProfilePhoto(req.user.id);
      await logAudit(req.user, "profile-photo-removed", req.user.id);
      const body: ProfilePhotoResponse = { profilePhotoUrl: null };
      res.json(body);
    } catch (error) {
      if (error instanceof ProfilePhotoBusyError) {
        sendApiError(res, 409, "PROFILE_PHOTO_BUSY", error.message);
        return;
      }
      if (error instanceof ProfilePhotoConfigError) {
        sendApiError(res, 503, "PROFILE_PHOTO_UNAVAILABLE", error.message);
        return;
      }
      console.error("Failed to remove profile photo", error);
      sendApiError(
        res,
        503,
        "PROFILE_PHOTO_UNAVAILABLE",
        "Profile photo could not be removed. Please try again.",
      );
    }
  }),
);
