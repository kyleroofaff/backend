import app from "./app.js";
import { env } from "./config/env.js";
import { hasPostgresConfig } from "./db/postgres.js";
import { bulkReplaceUsersInState } from "./db/store.js";
import { listAllPostgresUsers } from "./repositories/userRepository.js";

if (env.nodeEnv === "production" && !env.jwtSecret) {
  throw new Error("JWT_SECRET must be set in production.");
}

async function syncPostgresUsersOnStartup() {
  if (!hasPostgresConfig()) return;
  try {
    const pgUsers = await listAllPostgresUsers();
    if (pgUsers.length > 0) {
      bulkReplaceUsersInState(pgUsers);
      console.log(`Synced ${pgUsers.length} user(s) from Postgres into in-memory state.`);
    }
  } catch (err) {
    console.error("Failed to sync Postgres users on startup:", err.message);
  }
}

syncPostgresUsersOnStartup().then(() => {
  app.listen(env.port, () => {
    console.log(`API running at http://localhost:${env.port}`);
  });
});
