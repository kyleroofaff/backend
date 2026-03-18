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
  const emailVerified = profile.emailVerified !== false;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    sellerId: row.seller_id || null,
    barId: row.bar_id || null,
    accountStatus: row.account_status || "active",
    passwordHash: row.password_hash || "",
    emailVerified,
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
    emailVerified: user.emailVerified !== false,
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

export async function createUser({
  id,
  email,
  name,
  role,
  accountStatus = "active",
  passwordHash = "",
  sellerId = null,
  barId = null,
  profile = {}
}) {
  const normalizedId = String(id || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedName = String(name || "").trim();
  const normalizedRole = String(role || "").trim().toLowerCase();
  const normalizedAccountStatus = String(accountStatus || "active").trim().toLowerCase();
  if (!normalizedId || !normalizedEmail || !normalizedName || !normalizedRole || !passwordHash) {
    throw new Error("Missing required user fields.");
  }

  if (hasPostgresConfig()) {
    const nextProfile = profile && typeof profile === "object" ? profile : {};
    const result = await pgQuery(
      `INSERT INTO app_users (id, email, name, role, seller_id, bar_id, account_status, password_hash, profile)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id, email, name, role, seller_id, bar_id, account_status, password_hash, profile`,
      [
        normalizedId,
        normalizedEmail,
        normalizedName,
        normalizedRole,
        sellerId || null,
        barId || null,
        normalizedAccountStatus,
        String(passwordHash),
        JSON.stringify(nextProfile)
      ]
    );
    return mapPostgresUser(result.rows[0] || null);
  }

  const state = getState();
  const duplicate = (state.users || []).some(
    (entry) => String(entry?.email || "").trim().toLowerCase() === normalizedEmail
  );
  if (duplicate) {
    throw new Error("Email already exists.");
  }
  const nextProfile = profile && typeof profile === "object" ? profile : {};
  const nextUser = {
    id: normalizedId,
    email: normalizedEmail,
    name: normalizedName,
    role: normalizedRole,
    sellerId: sellerId || null,
    barId: barId || null,
    accountStatus: normalizedAccountStatus,
    password: String(passwordHash),
    emailVerified: nextProfile.emailVerified !== false,
    emailVerificationToken: String(nextProfile.emailVerificationToken || ""),
    emailVerificationExpiresAt: String(nextProfile.emailVerificationExpiresAt || ""),
    preferredLanguage: normalizePreferredLanguage(nextProfile.preferredLanguage),
    notificationPreferences: normalizeNotificationPreferences(nextProfile.notificationPreferences || {}, normalizedRole)
  };
  const nextState = {
    ...state,
    users: [...(state.users || []), nextUser]
  };
  await replaceStateAndSeed(nextState);
  return mapStateUser(nextUser);
}

export async function verifyUserEmailToken(email, token) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedToken = String(token || "").trim();
  if (!normalizedEmail || !normalizedToken) {
    return { ok: false, reason: "missing" };
  }

  if (hasPostgresConfig()) {
    const result = await pgQuery(
      `SELECT id, profile
       FROM app_users
       WHERE lower(email) = $1
       LIMIT 1`,
      [normalizedEmail]
    );
    const row = result.rows[0];
    if (!row) return { ok: false, reason: "not_found" };
    const profile = parseProfile(row.profile);
    const storedToken = String(profile.emailVerificationToken || "");
    if (!storedToken || storedToken !== normalizedToken) return { ok: false, reason: "invalid_token" };
    const expiresAtRaw = String(profile.emailVerificationExpiresAt || "");
    const expiresAtMs = Date.parse(expiresAtRaw);
    if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
      return { ok: false, reason: "expired" };
    }
    const nextProfile = {
      ...profile,
      emailVerified: true
    };
    delete nextProfile.emailVerificationToken;
    delete nextProfile.emailVerificationExpiresAt;
    await pgQuery(
      `UPDATE app_users
       SET profile = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, JSON.stringify(nextProfile)]
    );
    const refreshedUser = await getUserById(row.id);
    return { ok: true, user: refreshedUser };
  }

  const state = getState();
  const existingUser = (state.users || []).find(
    (entry) => String(entry?.email || "").trim().toLowerCase() === normalizedEmail
  );
  if (!existingUser) return { ok: false, reason: "not_found" };
  const storedToken = String(existingUser.emailVerificationToken || "");
  if (!storedToken || storedToken !== normalizedToken) return { ok: false, reason: "invalid_token" };
  const expiresAtRaw = String(existingUser.emailVerificationExpiresAt || "");
  const expiresAtMs = Date.parse(expiresAtRaw);
  if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  const nextState = {
    ...state,
    users: (state.users || []).map((entry) => (
      String(entry?.email || "").trim().toLowerCase() === normalizedEmail
        ? {
            ...entry,
            emailVerified: true,
            emailVerificationToken: "",
            emailVerificationExpiresAt: ""
          }
        : entry
    ))
  };
  await replaceStateAndSeed(nextState);
  const verifiedUser = await getUserByEmail(normalizedEmail);
  return { ok: true, user: verifiedUser };
}

export async function setUserEmailVerificationToken(email, token, expiresAt) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedToken = String(token || "").trim();
  const normalizedExpiresAt = String(expiresAt || "").trim();
  if (!normalizedEmail || !normalizedToken || !normalizedExpiresAt) {
    return null;
  }

  if (hasPostgresConfig()) {
    const result = await pgQuery(
      `SELECT id, profile
       FROM app_users
       WHERE lower(email) = $1
       LIMIT 1`,
      [normalizedEmail]
    );
    const row = result.rows[0];
    if (!row) return null;
    const profile = parseProfile(row.profile);
    const nextProfile = {
      ...profile,
      emailVerified: false,
      emailVerificationToken: normalizedToken,
      emailVerificationExpiresAt: normalizedExpiresAt
    };
    await pgQuery(
      `UPDATE app_users
       SET profile = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, JSON.stringify(nextProfile)]
    );
    return getUserById(row.id);
  }

  const state = getState();
  const existingUser = (state.users || []).find(
    (entry) => String(entry?.email || "").trim().toLowerCase() === normalizedEmail
  );
  if (!existingUser) return null;
  const nextState = {
    ...state,
    users: (state.users || []).map((entry) => (
      String(entry?.email || "").trim().toLowerCase() === normalizedEmail
        ? {
            ...entry,
            emailVerified: false,
            emailVerificationToken: normalizedToken,
            emailVerificationExpiresAt: normalizedExpiresAt
          }
        : entry
    ))
  };
  await replaceStateAndSeed(nextState);
  return getUserByEmail(normalizedEmail);
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
