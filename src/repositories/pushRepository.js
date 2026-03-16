import { getState, replaceStateAndSeed } from "../db/store.js";
import { hasPostgresConfig, pgQuery } from "../db/postgres.js";

function mapPushRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createPushSubscriptionId() {
  return `push_sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function upsertPushSubscription({ userId, role, endpoint, p256dh, auth }) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedRole = String(role || "").trim();
  const normalizedEndpoint = String(endpoint || "").trim();
  const normalizedP256dh = String(p256dh || "").trim();
  const normalizedAuth = String(auth || "").trim();

  if (!normalizedUserId || !normalizedRole || !normalizedEndpoint || !normalizedP256dh || !normalizedAuth) {
    throw new Error("Invalid push subscription payload.");
  }

  if (hasPostgresConfig()) {
    const id = createPushSubscriptionId();
    const result = await pgQuery(
      `INSERT INTO push_subscriptions(id, user_id, role, endpoint, p256dh, auth, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (endpoint)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         role = EXCLUDED.role,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         is_active = TRUE,
         updated_at = NOW()
       RETURNING id, user_id, role, endpoint, p256dh, auth, is_active, created_at, updated_at`,
      [id, normalizedUserId, normalizedRole, normalizedEndpoint, normalizedP256dh, normalizedAuth]
    );
    return mapPushRow(result.rows[0]);
  }

  const prev = getState();
  const now = new Date().toISOString();
  const existing = (prev.pushSubscriptions || []).find(
    (entry) => String(entry.endpoint || "").trim() === normalizedEndpoint
  );
  const nextRows = existing
    ? (prev.pushSubscriptions || []).map((entry) => (
        String(entry.endpoint || "").trim() === normalizedEndpoint
          ? {
              ...entry,
              userId: normalizedUserId,
              role: normalizedRole,
              endpoint: normalizedEndpoint,
              p256dh: normalizedP256dh,
              auth: normalizedAuth,
              isActive: true,
              updatedAt: now
            }
          : entry
      ))
    : [
        {
          id: createPushSubscriptionId(),
          userId: normalizedUserId,
          role: normalizedRole,
          endpoint: normalizedEndpoint,
          p256dh: normalizedP256dh,
          auth: normalizedAuth,
          isActive: true,
          createdAt: now,
          updatedAt: now
        },
        ...(prev.pushSubscriptions || [])
      ];
  await replaceStateAndSeed({
    ...prev,
    pushSubscriptions: nextRows
  });
  return (getState().pushSubscriptions || []).find(
    (entry) => String(entry.endpoint || "").trim() === normalizedEndpoint
  ) || null;
}

export async function deactivatePushSubscription({ userId, endpoint }) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedEndpoint = String(endpoint || "").trim();
  if (!normalizedUserId || !normalizedEndpoint) {
    return false;
  }

  if (hasPostgresConfig()) {
    const result = await pgQuery(
      `UPDATE push_subscriptions
       SET is_active = FALSE,
           updated_at = NOW()
       WHERE user_id = $1
         AND endpoint = $2
         AND is_active = TRUE`,
      [normalizedUserId, normalizedEndpoint]
    );
    return result.rowCount > 0;
  }

  const prev = getState();
  const now = new Date().toISOString();
  let changed = false;
  const nextRows = (prev.pushSubscriptions || []).map((entry) => {
    const isMatch =
      String(entry.userId || "").trim() === normalizedUserId &&
      String(entry.endpoint || "").trim() === normalizedEndpoint &&
      entry.isActive !== false;
    if (!isMatch) return entry;
    changed = true;
    return {
      ...entry,
      isActive: false,
      updatedAt: now
    };
  });
  if (!changed) return false;
  await replaceStateAndSeed({
    ...prev,
    pushSubscriptions: nextRows
  });
  return true;
}

export async function deactivatePushSubscriptionByEndpoint(endpoint) {
  const normalizedEndpoint = String(endpoint || "").trim();
  if (!normalizedEndpoint) return false;

  if (hasPostgresConfig()) {
    const result = await pgQuery(
      `UPDATE push_subscriptions
       SET is_active = FALSE,
           updated_at = NOW()
       WHERE endpoint = $1
         AND is_active = TRUE`,
      [normalizedEndpoint]
    );
    return result.rowCount > 0;
  }

  const prev = getState();
  const now = new Date().toISOString();
  let changed = false;
  const nextRows = (prev.pushSubscriptions || []).map((entry) => {
    const isMatch =
      String(entry.endpoint || "").trim() === normalizedEndpoint &&
      entry.isActive !== false;
    if (!isMatch) return entry;
    changed = true;
    return {
      ...entry,
      isActive: false,
      updatedAt: now
    };
  });
  if (!changed) return false;
  await replaceStateAndSeed({
    ...prev,
    pushSubscriptions: nextRows
  });
  return true;
}

export async function listActivePushSubscriptionsByUserId(userId) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return [];

  if (hasPostgresConfig()) {
    const result = await pgQuery(
      `SELECT id, user_id, role, endpoint, p256dh, auth, is_active, created_at, updated_at
       FROM push_subscriptions
       WHERE user_id = $1
         AND is_active = TRUE
       ORDER BY updated_at DESC`,
      [normalizedUserId]
    );
    return result.rows.map(mapPushRow).filter(Boolean);
  }

  return (getState().pushSubscriptions || [])
    .filter((entry) =>
      String(entry.userId || "").trim() === normalizedUserId &&
      entry.isActive !== false
    )
    .map((entry) => ({
      ...entry,
      isActive: entry.isActive !== false
    }));
}
