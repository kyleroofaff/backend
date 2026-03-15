import { getState } from "../src/db/store.js";
import { withPgTransaction } from "../src/db/postgres.js";
import { hashPassword } from "../src/utils/password.js";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function run() {
  const users = (getState().users || []).filter((user) => normalizeEmail(user.email));
  if (!users.length) {
    console.log("No users in state to seed.");
    return;
  }

  await withPgTransaction(async (client) => {
    const countResult = await client.query("SELECT COUNT(*)::int AS count FROM app_users");
    const existingCount = Number(countResult.rows[0]?.count || 0);
    if (existingCount > 0) {
      console.log("app_users already has data; skipping seed.");
      return;
    }

    for (const user of users) {
      await client.query(
        `INSERT INTO app_users (
          id, email, name, role, seller_id, bar_id, account_status, password_hash, profile
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          user.id,
          normalizeEmail(user.email),
          String(user.name || user.id || "User"),
          String(user.role || "buyer"),
          user.sellerId || null,
          user.barId || null,
          String(user.accountStatus || "active"),
          hashPassword(String(user.password || "demo123")),
          {}
        ]
      );
    }

    console.log(`Seeded ${users.length} auth users into app_users.`);
  });
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Auth seed failed:", error);
    process.exit(1);
  });
