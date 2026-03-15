import crypto from "node:crypto";
import { hasPostgresConfig, pgQuery } from "../db/postgres.js";

const memoryIdempotencyStore = new Map();
const MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

function now() {
  return Date.now();
}

function cleanupMemoryStore() {
  const threshold = now() - MEMORY_TTL_MS;
  for (const [key, value] of memoryIdempotencyStore.entries()) {
    if (value.createdAt < threshold) {
      memoryIdempotencyStore.delete(key);
    }
  }
}

function stableJsonStringify(input) {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map((item) => stableJsonStringify(item)).join(",")}]`;
  const keys = Object.keys(input).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(input[key])}`).join(",")}}`;
}

function requestHash(req) {
  const payload = stableJsonStringify(req.body || {});
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function actorKey(req) {
  return String(req.auth?.user?.id || "anonymous");
}

function compoundKey(idempotencyKey, actorUserId) {
  return `${actorUserId}::${idempotencyKey}`;
}

async function getStoredResponse({ idempotencyKey, actorUserId }) {
  if (!idempotencyKey) return null;
  if (hasPostgresConfig()) {
    const result = await pgQuery(
      `SELECT request_hash, status_code, response_body
       FROM idempotency_keys
       WHERE idempotency_key = $1 AND actor_user_id = $2
       LIMIT 1`,
      [idempotencyKey, actorUserId]
    );
    return result.rows[0] || null;
  }
  cleanupMemoryStore();
  return memoryIdempotencyStore.get(compoundKey(idempotencyKey, actorUserId)) || null;
}

async function saveResponse({ idempotencyKey, actorUserId, method, path, hash, statusCode, body }) {
  if (!idempotencyKey) return;
  if (hasPostgresConfig()) {
    await pgQuery(
      `INSERT INTO idempotency_keys (
        id, idempotency_key, actor_user_id, method, path, request_hash, status_code, response_body
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (idempotency_key, actor_user_id) DO NOTHING`,
      [
        `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        idempotencyKey,
        actorUserId,
        method,
        path,
        hash,
        statusCode,
        body || {}
      ]
    );
    return;
  }

  memoryIdempotencyStore.set(compoundKey(idempotencyKey, actorUserId), {
    request_hash: hash,
    status_code: statusCode,
    response_body: body || {},
    createdAt: now()
  });
}

export function idempotencyOptional(req, res, next) {
  const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
  if (!idempotencyKey) return next();

  const hash = requestHash(req);
  const actorUserId = actorKey(req);

  getStoredResponse({ idempotencyKey, actorUserId })
    .then((existing) => {
      if (existing) {
        if (String(existing.request_hash) !== hash) {
          return res.status(409).json({
            error: "Idempotency-Key already used with different request payload."
          });
        }
        return res.status(Number(existing.status_code || 200)).json(existing.response_body || {});
      }

      const originalJson = res.json.bind(res);
      res.json = (payload) => {
        const statusCode = res.statusCode || 200;
        saveResponse({
          idempotencyKey,
          actorUserId,
          method: req.method,
          path: req.originalUrl,
          hash,
          statusCode,
          body: payload
        }).catch(() => {});
        return originalJson(payload);
      };
      return next();
    })
    .catch(next);
}

export function requireIdempotencyKey(req, res, next) {
  const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
  if (!idempotencyKey) {
    return res.status(400).json({ error: "Idempotency-Key header is required for this endpoint." });
  }
  return next();
}
