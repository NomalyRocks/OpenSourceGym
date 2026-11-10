import { ObjectId } from "mongodb";
import { z } from "zod";

// Transform during parsing so even partially valid refusal records use canonical IDs.
const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i)
  .transform((value) => new ObjectId(value).toHexString());

export const gateOpenSchema = z.object({
  userId: objectIdSchema,
  deviceId: objectIdSchema,
  direction: z.enum(["in", "out"]),
  reason: z.string().trim().min(3).max(200),
});

export const gateOpenIdentitySchema = z.object({
  userId: objectIdSchema.optional().catch(undefined),
  deviceId: objectIdSchema.optional().catch(undefined),
  direction: gateOpenSchema.shape.direction.optional().catch(undefined),
  reason: gateOpenSchema.shape.reason.optional().catch(undefined),
});
