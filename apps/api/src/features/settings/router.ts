import { Router } from "express";
import { z } from "zod";
import type { ChainSettings } from "@opengym/shared";
import { sendApiError } from "../../core/apiError.js";
import {
  findChainSettings,
  chainSettingsCollection,
  CHAIN_SETTINGS_ID,
  type ChainSettingsDocument,
} from "../../core/db.js";
import { logAudit } from "../../core/audit.js";
import { authed, requireRole } from "../../core/middleware.js";
import { LEGAL_DEFAULTS } from "./legal.js";
import { legalDocumentUrlSchema } from "./legalUrl.js";
import { freezeConfigSchema, getFreezeConfig } from "../freeze/freeze.js";
import { currencySchema, getChainCurrency } from "../payments/money.js";

export const settingsRouter: Router = Router();

// Chain-wide settings (owner only): chain display name and legal documents.
// Gym-specific settings live under /api/admin/gyms/:gymId/settings.
settingsRouter.get(
  "/settings",
  requireRole("owner", "admin"),
  async (_req, res) => {
    const doc = await findChainSettings();
    const settings: ChainSettings = {
      chainName: doc?.chainName ?? "",
      legal: { ...LEGAL_DEFAULTS, ...(doc?.legal ?? {}) },
      freeze: await getFreezeConfig(),
      currency: await getChainCurrency(),
    };
    res.json(settings);
  },
);

// An empty string means clear: deleting the field in the panel resets the URL
// to null while the consent checkbox remains visible without a link.
const legalUrlSchema = z
  .union([legalDocumentUrlSchema, z.literal("")])
  .nullish()
  .transform((value) => (value ? value : null));

const legalSchema = z.object({
  dataProcessingUrl: legalUrlSchema,
  privacyUrl: legalUrlSchema,
  version: z.coerce.number().int().min(1).max(1_000_000),
});

const chainSettingsSchema = z.object({
  chainName: z.string().trim().min(1),
  // Preserve the existing legal document URLs when absent.
  legal: legalSchema.optional(),
  // Preserve the existing freeze rules when absent.
  freeze: freezeConfigSchema.optional(),
  // Preserve the existing currency when absent; only new sales use a change.
  currency: currencySchema.optional(),
});

settingsRouter.put(
  "/settings",
  requireRole("owner"),
  authed(async (req, res) => {
    const parsed = chainSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? "");
      if (field === "currency") {
        sendApiError(
          res,
          400,
          "INVALID_CURRENCY",
          "Currency must be one of TRY, USD, EUR or GBP.",
        );
      } else if (field === "freeze") {
        sendApiError(
          res,
          400,
          "INVALID_FREEZE_SETTINGS",
          "Invalid subscription freeze settings.",
        );
      } else if (field === "legal") {
        sendApiError(
          res,
          400,
          "INVALID_LEGAL_SETTINGS",
          "Invalid legal document settings.",
        );
      } else {
        sendApiError(res, 400, "GYM_NAME_REQUIRED", "Chain name is required.");
      }
      return;
    }
    const { chainName, legal, freeze, currency } = parsed.data;
    const setDoc: Partial<Omit<ChainSettingsDocument, "_id">> = { chainName };
    if (legal !== undefined) setDoc.legal = legal;
    if (freeze !== undefined) setDoc.freeze = freeze;
    if (currency !== undefined) setDoc.currency = currency;

    await chainSettingsCollection().updateOne(
      { _id: CHAIN_SETTINGS_ID },
      { $set: setDoc },
      { upsert: true },
    );
    await logAudit(req.user, "settings-updated", undefined, {
      chainName,
      // The consent-text version presented is evidence in a legal dispute, so
      // changes must be recorded in the audit log.
      ...(legal !== undefined ? { legal } : {}),
      ...(freeze !== undefined ? { freeze } : {}),
      ...(currency !== undefined ? { currency } : {}),
    });
    res.json({ ok: true });
  }),
);
