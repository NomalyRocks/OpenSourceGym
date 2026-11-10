import { z } from "zod";

export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z.string().min(1).max(100),
});

export const lookupInviteSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const acceptInviteSchema = lookupInviteSchema.extend({
  password: z.string().min(8).max(128),
  dataProcessingAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  legalVersion: z.number().int().min(1),
});
