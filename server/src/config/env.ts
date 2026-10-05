import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z
    .coerce
    .number()
    .int()
    .positive()
    .max(65535)
    .default(5000),

  MONGO_URI: z
    .string()
    .trim()
    .min(1, "MONGO_URI is required"),

  REDIS_URL: z
    .string()
    .trim()
    .min(1, "REDIS_URL is required"),

  JWT_ACCESS_SECRET: z
    .string()
    .trim()
    .min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),

  JWT_REFRESH_SECRET: z
    .string()
    .trim()
    .min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),

  JWT_ACCESS_EXPIRES_IN: z
    .string()
    .trim()
    .min(1, "JWT_ACCESS_EXPIRES_IN is required"),

  JWT_REFRESH_EXPIRES_IN: z
    .string()
    .trim()
    .min(1, "JWT_REFRESH_EXPIRES_IN is required"),

  CLIENT_URL: z
    .string()
    .trim()
    .url("CLIENT_URL must be a valid URL"),

  EMAIL_HOST: z
    .string()
    .trim()
    .min(1, "EMAIL_HOST is required"),

  EMAIL_PORT: z
    .coerce
    .number()
    .int()
    .positive()
    .max(65535),

  EMAIL_USER: z
    .string()
    .trim()
    .email("EMAIL_USER must be a valid email address"),

  EMAIL_PASSWORD: z
    .string()
    .trim()
    .min(1, "EMAIL_PASSWORD is required"),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsedEnv.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsedEnv.data;