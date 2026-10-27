import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { operatorPrompt } from "./operator-prompt";

function terminal() {
  let shown = "";
  const input = new PassThrough();
  const output = new Writable({
    write(chunk, _encoding, done) {
      shown += String(chunk);
      done();
    },
  });
  return { input, output, shown: () => shown };
}

describe("operator prompt", () => {
  it("never echoes a hidden answer", async () => {
    const t = terminal();
    const prompt = operatorPrompt({ input: t.input, output: t.output, terminal: true });
    const answer = prompt.ask("New password (hidden): ", true);
    t.input.write("S3cretX9\r");
    expect(await answer).toBe("S3cretX9");
    expect(t.shown()).toContain("New password (hidden): ");
    expect(t.shown()).not.toContain("S3cret");
    prompt.close();
  });

  it("refuses a hidden question without a terminal", async () => {
    const t = terminal();
    await expect(operatorPrompt({ input: t.input, output: t.output, terminal: false }).ask("Password: ", true)).rejects.toThrow(/needs a terminal/);
  });

  it("cancels when the input closes (Ctrl+C or end of input)", async () => {
    const t = terminal();
    const prompt = operatorPrompt({ input: t.input, output: t.output, terminal: true });
    const answer = prompt.ask("Type yes to continue: ");
    t.input.end();
    await expect(answer).rejects.toThrow("Cancelled. Nothing was changed.");
  });
});
