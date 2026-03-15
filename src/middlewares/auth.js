import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { getUserById } from "../repositories/userRepository.js";

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    sellerId: user.sellerId || null,
    barId: user.barId || null
  };
}

export function buildAuthPayload(user) {
  return {
    sub: user.id,
    role: user.role,
    sellerId: user.sellerId || null,
    barId: user.barId || null
  };
}

export function signAuthToken(payload) {
  if (!env.jwtSecret) {
    throw new Error("JWT_SECRET is required to sign auth tokens.");
  }
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

export function requireAuth(req, res, next) {
  if (!env.jwtSecret) {
    return res.status(500).json({ error: "Server authentication is not configured." });
  }
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Authorization token is required." });
  }
  (async () => {
    const payload = jwt.verify(token, env.jwtSecret);
    const user = await getUserById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: "Invalid authentication token." });
    }
    req.auth = {
      ...payload,
      user: toPublicUser(user)
    };
    return next();
  })().catch(() => res.status(401).json({ error: "Invalid or expired authentication token." }));
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const role = req.auth?.user?.role;
    if (!role) {
      return res.status(401).json({ error: "Authentication required." });
    }
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ error: "Insufficient permissions." });
    }
    return next();
  };
}

export function requireNonProduction(req, res, next) {
  if (env.nodeEnv === "production") {
    return res.status(403).json({ error: "Endpoint disabled in production." });
  }
  return next();
}
