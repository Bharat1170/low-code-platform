import { z } from "zod";

export const sessionIdParamSchema = z
  .object({
    sessionId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, "Invalid session ID"),
  })
  .strict();

export type SessionIdParamInput = z.infer<
  typeof sessionIdParamSchema
>;
