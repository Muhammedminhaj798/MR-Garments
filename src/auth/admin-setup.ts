// Checks for the operator command scripts/create-admin.ts (F2, F3): which database it will write to, whether that is
// the one the operator named, and what it prints. Nothing here connects to a database.

const LOCAL_HOST = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|::1|0\.0\.0\.0)$/i;
const DEV_OR_TEST_DATABASE = /^mr_garments_(dev|test|a[1-5])$/i;
const FORM = "postgresql://<role>:<password>@<host>/<database>";

type Target = { database: string; host: string };

/**
 * The database and host pg will connect to, read the way pg-connection-string reads them: the database is the URL
 * path, the host is the URL host unless a ?host= parameter overrides it. Forms where the host could come from
 * somewhere else (a ?host= parameter, an empty host that falls back to PGHOST or localhost, a Unix socket) are refused
 * rather than guessed. Messages never include the connection string.
 */
export function connectionTarget(connectionString: string): Target | { problem: string } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { problem: `DATABASE_URL is not a valid address. Use ${FORM}.` };
  }
  const rawHost = url.hostname.replace(/^\[(.+)\]$/, "$1");
  if (url.searchParams.has("host") || !rawHost || /^%2f/i.test(rawHost)) {
    return { problem: `DATABASE_URL must name its host in the address itself, with no ?host= parameter. Use ${FORM}.` };
  }
  const database = decodeURI(url.pathname.slice(1));
  if (!database) return { problem: `DATABASE_URL must name the database. Use ${FORM}.` };
  return { database, host: decodeURIComponent(rawHost).toLowerCase() };
}

/**
 * F2: why the admin may not be created in this database, or null when it may. --target must name exactly the database
 * and host DATABASE_URL points to, and production refuses local hosts and the development and test databases.
 */
export function targetProblem(connectionString: string, expected: string | undefined, nodeEnv: string): string | null {
  const target = connectionTarget(connectionString);
  if ("problem" in target) return target.problem;
  const actual = `${target.database}@${target.host}`;
  const named = expected?.trim() ?? "";
  if (!named) return "Name the database to write to: --target <database>@<host>. Nothing was changed.";
  const at = named.lastIndexOf("@");
  const database = named.slice(0, at);
  const host = named.slice(at + 1).replace(/^\[(.+)\]$/, "$1").toLowerCase();
  if (at <= 0 || !host) return "--target must be <database>@<host>, for example neondb@ep-example-123456.ap-southeast-1.aws.neon.tech.";
  if (database !== target.database || host !== target.host) {
    return `--target ${named} does not match DATABASE_URL, which points to ${actual}. Nothing was changed.`;
  }
  if (nodeEnv === "production" && (LOCAL_HOST.test(target.host) || DEV_OR_TEST_DATABASE.test(target.database))) {
    return `${actual} is a local or development/test database, which production refuses. Nothing was changed.`;
  }
  return null;
}

/** F3: the TLS setting DATABASE_URL asks for, shown before writing. Only the setting, never other parameters. */
export function tlsMode(connectionString: string) {
  const params = new URL(connectionString).searchParams;
  const sslmode = params.get("sslmode");
  if (sslmode) return `sslmode=${sslmode}`;
  return params.get("ssl") === "true" || params.get("ssl") === "1" ? "ssl=true" : "no TLS (sslmode not set)";
}

/** F3: where the new admin signs in: the frontend address the API accepts changes from (APP_ORIGIN). */
export const signInUrl = (appOrigin: string) => new URL("/login", appOrigin).href;
