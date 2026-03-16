import { getState, replaceStateAndSeed } from "../db/store.js";
import { hasPostgresConfig, pgQuery } from "../db/postgres.js";

function normalizeNotificationPreferences(rawPreferences = {}, role = "") {
  const base = {
    message: rawPreferences?.message !== false,
    engagement: rawPreferences?.engagement !== false
  };
  const basePush = {
    message: rawPreferences?.push?.message !== false,
    engagement: rawPreferences?.push?.engagement !== false
  };
  if (role === "admin") {
    basePush.adminOps = rawPreferences?.push?.adminOps !== false;
  }
  return {
    ...base,
    push: basePush
  };
}

function normalizePreferredLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["en", "th", "my", "ru"].includes(normalized) ? normalized : "en";
}

function parseProfile(rawProfile) {
  if (!rawProfile) return {};
  if (typeof rawProfile === "object") return rawProfile;
  try {
    const parsed = JSON.parse(rawProfile);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function mapPostgresUser(row) {
  if (!row) return null;
  const profile = parseProfile(row.profile);
  const role = row.role || "";
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    sellerId: row.seller_id || null,
    barId: row.bar_id || null,
    accountStatus: row.account_status || "active",
    passwordHash: row.password_hash || "",
    preferredLanguage: normalizePreferredLanguage(profile.preferredLanguage),
    notificationPreferences: normalizeNotificationPreferences(profile.notificationPreferences || {}, role)
  };
}

function mapStateUser(user) {
  if (!user) return null;
  const role = String(user.role || "");
  return {
    ...user,
    passwordHash: String(user.password || ""),
    preferredLanguage: normalizePreferredLanguage(user.preferredLanguage),
    notificationPreferences: normalizeNotificationPreferences(user.notificationPreferences || {}, role)
  };
}

export async function getUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  if (hasPostgresConfig()) {
    const result = await pgQuery(
      `SELECT id, email, name, role, seller_id, bar_id, account_status, password_hash, profile
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
      `SELECT id, email, name, role, seller_id, bar_id, account_status, password_hash, profile
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

export async function updateUserPushPreferences(userId, pushPatch = {}) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return null;
  }
  const patch = {
    ...(pushPatch?.message === undefined ? {} : { message: Boolean(pushPatch.message) }),
    ...(pushPatch?.engagement === undefined ? {} : { engagement: Boolean(pushPatch.engagement) }),
    ...(pushPatch?.adminOps === undefined ? {} : { adminOps: Boolean(pushPatch.adminOps) })
  };

  if (hasPostgresConfig()) {
    const currentResult = await pgQuery(
      `SELECT id, role, profile
       FROM app_users
       WHERE id = $1
       LIMIT 1`,
      [normalizedUserId]
    );
    const row = currentResult.rows[0];
    if (!row) return null;
    const profile = parseProfile(row.profile);
    const existingPreferences = normalizeNotificationPreferences(profile.notificationPreferences || {}, row.role || "");
    const nextPreferences = {
      ...existingPreferences,
      push: {
        ...(existingPreferences.push || {}),
        ...patch
      }
    };
    profile.notificationPreferences = nextPreferences;
    await pgQuery(
      `UPDATE app_users
       SET profile = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [normalizedUserId, JSON.stringify(profile)]
    );
    const refreshed = await getUserById(normalizedUserId);
    return refreshed;
  }

  const state = getState();
  const user = (state.users || []).find((entry) => entry.id === normalizedUserId);
  if (!user) return null;
  const existingPreferences = normalizeNotificationPreferences(user.notificationPreferences || {}, user.role || "");
  const nextPreferences = {
    ...existingPreferences,
    push: {
      ...(existingPreferences.push || {}),
      ...patch
    }
  };
  const nextState = {
    ...state,
    users: (state.users || []).map((entry) => (
      entry.id === normalizedUserId
        ? { ...entry, notificationPreferences: nextPreferences }
        : entry
    ))
  };
  await replaceStateAndSeed(nextState);
  return getUserById(normalizedUserId);
}
