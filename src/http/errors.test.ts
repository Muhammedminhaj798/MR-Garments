import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { loggable } from "./errors";

describe("loggable (B9.16)", () => {
  it("keeps a failed query's parameters and PostgreSQL's row detail out of the log", () => {
    const hash = "$argon2id$v=19$m=19456,t=2,p=1$not-a-real-hash";
    const cause = Object.assign(new Error('new row for relation "users" violates check constraint "users_role_check"'), {
      code: "23514",
      constraint: "users_role_check",
      detail: `Failing row contains (${hash}).`,
    });
    const error = new DrizzleQueryError('insert into "users" ("password_hash") values ($1)', [hash], cause);
    const logged = JSON.stringify(loggable(error));
    expect(logged).not.toContain(hash);
    expect(logged).toContain("users_role_check");
    expect(logged).toContain("$1");

    const other = new Error("other");
    expect(loggable(other)).toBe(other);
  });
});
