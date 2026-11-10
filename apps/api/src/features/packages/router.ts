import { Router } from "express";
import { z } from "zod";
import type { Package, PackageListResponse } from "@opengym/shared";
import { sendApiError } from "../../core/apiError.js";
import { logAudit } from "../../core/audit.js";
import { toObjectId } from "../../core/db.js";
import { authed, requireRole } from "../../core/middleware.js";
import { getChainCurrency, priceMinorSchema } from "../payments/money.js";
import { packageDurationSchema } from "../subscriptions/sale.js";
import {
  listPackages,
  packageCollection,
  toPackage,
  type PackageFields,
} from "./packages.js";

export const packagesRouter: Router = Router();

const nameSchema = z.string().trim().min(1).max(80);

export const createPackageSchema = z
  .object({
    name: nameSchema,
    duration: packageDurationSchema,
    priceMinor: priceMinorSchema.nullable(),
  })
  .strict();

export const updatePackageSchema = z
  .object({
    name: nameSchema.optional(),
    duration: packageDurationSchema.optional(),
    priceMinor: priceMinorSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");

const listQuerySchema = z.object({ all: z.enum(["true", "false"]).optional() });

// The sale modal needs active packages, so every staff role can read them.
// Inactive ones are catalog management, which is the owner's.
packagesRouter.get(
  "/packages",
  requireRole("owner", "admin", "staff"),
  authed(async (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendApiError(res, 400, "INVALID_REQUEST", "Invalid list query.");
      return;
    }
    const includeInactive = query.data.all === "true";
    if (includeInactive && req.user.role !== "owner") {
      sendApiError(
        res,
        403,
        "FORBIDDEN",
        "Only the owner can list inactive packages.",
      );
      return;
    }
    const body: PackageListResponse = {
      packages: (await listPackages(!includeInactive)).map(toPackage),
      currency: await getChainCurrency(),
    };
    res.json(body);
  }),
);

packagesRouter.post(
  "/packages",
  requireRole("owner"),
  authed(async (req, res) => {
    const parsed = createPackageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_PACKAGE", "Invalid package.");
      return;
    }
    const now = new Date();
    const doc: PackageFields = {
      name: parsed.data.name,
      duration: parsed.data.duration,
      priceMinor: parsed.data.priceMinor,
      active: true,
      createdAt: now,
      createdBy: req.user.id,
      updatedAt: now,
      updatedBy: req.user.id,
    };
    const inserted = await packageCollection().insertOne(doc);
    await logAudit(
      req.user,
      "package-created",
      inserted.insertedId.toHexString(),
      {
        name: doc.name,
        duration: doc.duration,
        priceMinor: doc.priceMinor,
      },
    );
    const body: Package = toPackage({ ...doc, _id: inserted.insertedId });
    res.status(201).json(body);
  }),
);

packagesRouter.patch(
  "/packages/:id",
  requireRole("owner"),
  authed(async (req, res) => {
    const id = toObjectId(String(req.params.id ?? ""));
    const parsed = updatePackageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_PACKAGE", "Invalid package update.");
      return;
    }
    if (!id) {
      sendApiError(res, 404, "PACKAGE_NOT_FOUND", "Package not found.");
      return;
    }
    const changes = parsed.data;
    const set: Partial<PackageFields> = {
      updatedAt: new Date(),
      updatedBy: req.user.id,
    };
    if (changes.name !== undefined) set.name = changes.name;
    if (changes.duration !== undefined) set.duration = changes.duration;
    if (changes.priceMinor !== undefined) set.priceMinor = changes.priceMinor;
    if (changes.active !== undefined) set.active = changes.active;

    const before = await packageCollection().findOneAndUpdate(
      { _id: id },
      { $set: set },
      { returnDocument: "before" },
    );
    if (!before) {
      sendApiError(res, 404, "PACKAGE_NOT_FOUND", "Package not found.");
      return;
    }
    const after = { ...before, ...set };
    await logAudit(req.user, "package-updated", id.toHexString(), {
      before: {
        name: before.name,
        duration: before.duration,
        priceMinor: before.priceMinor,
        active: before.active,
      },
      after: {
        name: after.name,
        duration: after.duration,
        priceMinor: after.priceMinor,
        active: after.active,
      },
    });
    const body: Package = toPackage(after);
    res.json(body);
  }),
);
