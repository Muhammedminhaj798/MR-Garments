import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { verifyPassword } from "../../auth/passwords";
import { users } from "../../db/schema";
import { api, createTestContext, resetData, SEEDED, signInAs, TEST_PASSWORD } from "../../test/harness";
import { PASSWORD_CHANGE_DISABLED } from "./password.routes";

const ctx = createTestContext();
const http = api(ctx);
beforeEach(() => resetData(ctx));
afterAll(() => ctx.pool.end());

const NEW_PASSWORD = "Ledger2026x";
const disabled = { error: { code: "password_change_disabled", message: PASSWORD_CHANGE_DISABLED } };
const hashOf = async (email: string) => (await ctx.db.select().from(users).where(eq(users.email, email)))[0]!.passwordHash;

// Password policy: nobody changes or resets their own password in the application.
describe("AUTH-5 change-password and AUTH-4 reset-password are switched off", () => {
  const bodies = [
    { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    { token: "not-a-real-token", newPassword: NEW_PASSWORD },
    {},
    { anything: 1 },
  ];

  it("answers 403 password_change_disabled to everyone, signed in or not, whatever the body", async () => {
    const callers = [undefined, SEEDED.management, SEEDED.accounts, SEEDED.chinaStaff];
    for (const path of ["/auth/change-password", "/auth/reset-password"]) {
      for (const email of callers) {
        const cookie = email ? await signInAs(ctx, email) : undefined;
        for (const body of bodies) {
          const request = http.post(path, body);
          const res = await (cookie ? request.set("Cookie", cookie) : request);
          expect(res.status, `${path} ${email ?? "signed out"} ${JSON.stringify(body)}`).toBe(403);
          expect(res.body).toEqual(disabled);
        }
      }
    }
  });

  it("changes nothing: the password still works and the session stays signed in", async () => {
    const cookie = await signInAs(ctx, SEEDED.accounts);
    await http.post("/auth/change-password", bodies[0]!).set("Cookie", cookie);
    await http.post("/auth/reset-password", bodies[1]!);
    expect(await verifyPassword(await hashOf(SEEDED.accounts), TEST_PASSWORD)).toBe(true);
    expect((await http.get("/me").set("Cookie", cookie)).status).toBe(200);
    const login = await http.post("/auth/login", { email: SEEDED.accounts, password: TEST_PASSWORD, keepSignedIn: false });
    expect(login.status).toBe(200);
  });
});
