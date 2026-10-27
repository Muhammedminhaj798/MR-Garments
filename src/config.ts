import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { z } from "zod";

/** Loads `.env` from the working directory into process.env (values already set win). */
export function loadEnvFile(path = ".env") {
  if (existsSync(path)) process.loadEnvFile(path);
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  // Local databases use postgres://; Neon gives postgresql:// with sslmode in the query (see .env.example).
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL must start with postgres:// or postgresql://"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  // The frontend's address, compared with each request's Origin header (same-site.ts) and used to build links, so it
  // must be exactly what a browser sends: scheme, host and optional port, with no path or trailing slash.
  APP_ORIGIN: z.url().refine((value) => new URL(value).origin === value, "APP_ORIGIN must be only the frontend's origin, like https://app.example.com (no path or trailing slash)"),
  SEED_DEV_PASSWORD: z.string().optional(),
  // B1: the address the API listens on. Development keeps it on this computer; a hosting platform needs 0.0.0.0.
  HOST: z.string().trim().min(1, "HOST must not be empty").default("127.0.0.1"),
  // B2: which proxies may tell Express the client's address and protocol (X-Forwarded-For, X-Forwarded-Proto). The
  // sign-in limit keys on that address, and the Secure session cookie is only set when the protocol is https.
  TRUST_PROXY: z.string().trim().transform(parseTrustProxy).default("loopback"),
}).superRefine((settings, ctx) => {
  // A production frontend is served over https; its session cookie is Secure and would never reach an http origin.
  if (settings.NODE_ENV === "production" && new URL(settings.APP_ORIGIN).protocol !== "https:") {
    ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "APP_ORIGIN must use https in production" });
  }
});

const PROXY_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);
const isProxyAddress = (part: string) => {
  const [address = "", prefix, extra] = part.split("/");
  return isIP(address) !== 0 && extra === undefined && (prefix === undefined || /^\d{1,3}$/.test(prefix));
};

/**
 * Express "trust proxy" from TRUST_PROXY: a hop count ("2" = the two proxies nearest the API), "false", or a
 * comma-separated list of proxy names and addresses ("loopback, 10.0.0.0/8"). Development uses "loopback": requests
 * arrive through the Next.js /api forwarding on this computer. "true" is refused: it trusts any client-sent
 * X-Forwarded-For, which would let a client choose its own address and get round the sign-in limit.
 */
function parseTrustProxy(value: string, ctx: z.RefinementCtx<string>): number | false | string {
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  const parts = value.split(",").map((part) => part.trim());
  if (value && parts.every((part) => PROXY_NAMES.has(part) || isProxyAddress(part))) return parts.join(",");
  ctx.addIssue({ code: "custom", message: "TRUST_PROXY must be a hop count, false, or proxy names and addresses (true is not allowed)" });
  return z.NEVER;
}

export type Config = z.infer<typeof schema>;

/** Reads and checks the settings. Error messages name the setting but never print its value. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid settings in .env:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data;
}

const isLoopbackHost = (host: string) => /^(localhost|127(\.\d{1,3}){3}|::1)$/i.test(host);

/**
 * B1/B2: a production server must choose HOST and TRUST_PROXY for its platform. The development defaults would leave
 * the API unreachable (127.0.0.1) or stop the Secure session cookie behind the platform's proxy (loopback), so the
 * server refuses to start without them. Command-line scripts (migrate, admin:create) don't listen and don't need them.
 * C: outside production the API must stay on this computer, so a forgotten NODE_ENV can't serve development mode
 * (no Secure cookie, set-password links in the log) to other computers.
 */
export function requireHostingSettings(settings: Config, env: NodeJS.ProcessEnv = process.env) {
  if (settings.NODE_ENV !== "production") {
    if (!isLoopbackHost(settings.HOST)) {
      throw new Error(`Invalid settings in .env:\n  HOST: ${settings.HOST} is reachable from other computers, which needs NODE_ENV=production`);
    }
    return;
  }
  const missing = ["HOST", "TRUST_PROXY"].filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new Error(`Invalid settings in .env:\n  ${missing.map((name) => `${name}: must be set in production`).join("\n  ")}`);
}

/**
 * F1: the .env file is for development and tests. A process started with NODE_ENV=production in its real environment
 * takes every setting from that environment only, so a missing production setting fails instead of quietly borrowing
 * a development value such as the local DATABASE_URL.
 */
export const usesEnvFile = (env: NodeJS.ProcessEnv = process.env) => env.NODE_ENV !== "production";

let cached: Config | undefined;

export function config(): Config {
  if (!cached) {
    if (usesEnvFile()) loadEnvFile();
    cached = readConfig();
  }
  return cached;
}
