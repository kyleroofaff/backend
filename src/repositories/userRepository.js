import { getState } from "../db/store.js";
import { hasPostgresConfig, pgQuery } from "../db/postgres.js";

function mapPostgresUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    sellerId: row.seller_id || null,
    barId: row.bar_id || null,
    accountStatus: row.account_status || "active",
    passwordHash: row.password_hash || ""
  };
}

function mapStateUser(user) {
  if (!user) return null;
  return {
    ...user,
    passwordHash: String(user.password || "")
  };
}

export async function getUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  if (hasPostgresConfig()) {
    const result = await pgQuery(
      `SELECT id, email, name, role, seller_id, bar_id, account_status, password_hash
       FROM app_users
       WHERE lower(email) = $1
       LIMIT 1`,
      [normalized]
    );
    return mapPostgresUser(result.rows[0] || null);
  }

  const user = (getState().users || []).find(
    (candidate) => String(candidate.email || "").trim().toLowerCase() === normalized
  );
  return mapStateUser(user);
}

export async function getUserById(id) {
  const normalized = String(id || "").trim();
  if (!normalized) return null;

  if (hasPostgresConfig()) {
    const result = await pgQuery(
      `SELECT id, email, name, role, seller_id, bar_id, account_status, password_hash
       FROM app_users
       WHERE id = $1
       LIMIT 1`,
      [normalized]
    );
    return mapPostgresUser(result.rows[0] || null);
  }

  const user = (getState().users || []).find((candidate) => candidate.id === normalized);
  return mapStateUser(user);
}
