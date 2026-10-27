import { describe, expect, it } from "vitest";

import { hashPassword, passwordProblems, verifyPassword } from "./passwords";

describe("password rules (B9.10)", () => {
  it("requires 8-128 characters, a number and a capital letter", () => {
    expect(passwordProblems("Garments2026")).toEqual([]);
    expect(passwordProblems("garments2026")).toEqual(["no_capital"]);
    expect(passwordProblems("Garments")).toEqual(["no_number"]);
    expect(passwordProblems("Ab1")).toEqual(["too_short"]);
    expect(passwordProblems(`A1${"x".repeat(127)}`)).toEqual(["too_long"]);
  });

  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("Garments2026");
    const [, type, , params] = hash.split("$");
    expect(type).toBe("argon2id");
    expect(Object.fromEntries(params!.split(",").map((pair) => pair.split("=")))).toEqual({ m: "19456", t: "2", p: "1" });
    expect(await verifyPassword(hash, "Garments2026")).toBe(true);
    expect(await verifyPassword(hash, "garments2026")).toBe(false);
    expect(await verifyPassword(null, "Garments2026")).toBe(false);
  });
});
