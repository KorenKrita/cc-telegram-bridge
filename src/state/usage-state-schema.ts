import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const UsageTimestampSchema = z.union([
  z.literal(""),
  z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp"),
]);

export const UsageRecordSchema = z.object({
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  /** @deprecated Use totalCacheReadTokens instead */
  totalCachedTokens: z.number().int().nonnegative(),
  totalCacheReadTokens: z.number().int().nonnegative().optional().default(0),
  totalCacheCreationTokens: z.number().int().nonnegative().optional().default(0),
  totalCostUsd: z.number().nonnegative(),
  requestCount: z.number().int().nonnegative(),
  lastUpdatedAt: UsageTimestampSchema,
}).passthrough();
