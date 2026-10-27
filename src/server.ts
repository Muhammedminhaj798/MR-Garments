import { createApp } from "./app";
import { config, requireHostingSettings } from "./config";
import { database } from "./db/client";

const settings = config();
requireHostingSettings(settings);
const { db, pool } = database();
const app = createApp({ db, pool, config: settings });

// Express 5 hands a bind failure (port in use, unknown host) to this callback instead of throwing. Report it and exit
// non-zero, so a hosting platform sees a failed start rather than a "listening" line from a server that isn't.
app.listen(settings.PORT, settings.HOST, (error) => {
  if (error) {
    console.error(`MR Garments API could not listen on ${settings.HOST}:${settings.PORT}: ${error.message}`);
    process.exit(1);
  }
  console.info(`MR Garments API listening on http://${settings.HOST}:${settings.PORT} (${settings.NODE_ENV}).`);
});
