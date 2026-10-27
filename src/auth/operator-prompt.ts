import { stdin, stdout } from "node:process";
// The classic interface: only it has the _writeToOutput hook that hides typed passwords (readline/promises does not).
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type Prompt = { ask(question: string, hidden?: boolean): Promise<string>; close(): void };

type Options = { input?: Readable; output?: Writable; terminal?: boolean; noTerminalHint?: string };

/**
 * Questions for the operator commands (scripts/create-admin.ts, scripts/reset-admin-password.ts). A hidden question
 * echoes nothing and needs a terminal. The interface is created on first use, so input piped in before a question is
 * not lost. Ctrl+C or closed input rejects with "Cancelled. Nothing was changed."
 */
export function operatorPrompt({ input = stdin, output = stdout, terminal = Boolean(stdin.isTTY), noTerminalHint = "" }: Options = {}): Prompt {
  let rl: Interface | undefined;
  let muted = false;

  async function ask(question: string, hidden = false) {
    if (hidden && !terminal) {
      throw new Error(`A hidden password prompt needs a terminal such as PowerShell or Windows Terminal.${noTerminalHint}`);
    }
    if (!rl) {
      rl = createInterface({ input, output, terminal, historySize: 0 });
      const echo = rl as unknown as { _writeToOutput(text: string): void };
      const write = echo._writeToOutput.bind(rl);
      echo._writeToOutput = (text) => {
        if (!muted) write(text);
      };
      rl.on("SIGINT", () => rl?.close()); // Ctrl+C cancels (without a listener readline only pauses)
    }
    const current = rl;
    const answer = new Promise<string>((resolve, reject) => {
      current.question(question, resolve); // writes the prompt before muting
      current.once("close", () => reject(new Error("Cancelled. Nothing was changed.")));
    });
    muted = hidden;
    try {
      return await answer;
    } finally {
      if (hidden) output.write("\n");
      muted = false;
    }
  }

  return { ask, close: () => rl?.close() };
}
