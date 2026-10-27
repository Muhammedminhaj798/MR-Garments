import type { z } from "zod";

import { HttpError, validationFailed } from "./errors";

/**
 * Parses a request body or query with a Zod schema.
 * - Unknown fields (strict objects) or wrong shapes are a programming error: 400 (E11).
 * - Rule failures are field errors: 422 with `fields`, keyed by the first path segment (E1).
 * Schemas carry the approved messages (M1-M26), so the message here is what the user sees.
 */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues;
  if (issues.some((issue) => issue.code === "unrecognized_keys" || (issue.code === "invalid_type" && issue.path.length === 0))) {
    throw new HttpError(400, "bad_request", "Something went wrong.");
  }
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "form");
    fields[key] ??= issue.message;
  }
  throw validationFailed(fields);
}
