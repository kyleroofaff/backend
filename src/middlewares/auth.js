import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { getUserById } from "../repositories/userRepository.js";

export const ADMIN_SCOPES = {
  SALES_READ: "sales.read",
  PAYMENTS_MANAGE: "payments.manage",
  AFFILIATIONS_MANAGE: "affiliations.manage",
  DISPUTES_REVIEW: "disputes.review",
  USERS_BLOCK: "users.block",
  USERS_ADMIN_ACCESS_MANAGE: "users.admin_access.manage",
  USERS_CREDENTIALS_MANAGE: "users.credentials.manage",
  EMAIL_INBOX_MANAGE: "email.inbox.manage",
  EMAIL_TEMPLATES_MANAGE: "email.templates.manage",
  AUTH_REVIEW: "auth.review",
  PRODUCTS_MODERATE: "products.moderate",
  CMS_MANAGE: "cms.manage",
};

const KNOWN_ADMIN_SCOPES = new Set(Object.values(ADMIN_SCOPES));

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

export function normalizeAdminAccess(adminAccess, role = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "admin") {
    return {
      enabled: true,
      level: "super",
      scopes: ["*"],
    };
  }
  const raw = adminAccess && typeof adminAccess === "object" ? adminAccess : {};
  const enabled = raw.enabled === true;
  const level = raw.level === "super" ? "super" : "limited";
  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes
        .map((entry) => String(entry || "").trim())
        .filter((entry) => KNOWN_ADMIN_SCOPES.has(entry))
    : [];
  if (!enabled) {
    return { enabled: false, level: "none", scopes: [] };
  }
  if (level === "super") {
    return { enabled: true, level: "super", scopes: ["*"] };
  }
  return {
    enabled: true,
    level: "limited",
    scopes,
  };
}

export function hasAdminAccess(user) {
  const normalized = normalizeAdminAccess(user?.adminAccess, user?.role);
  return normalized.enabled || normalized.level === "super";
}

export function isSuperAdmin(user) {
  const normalized = normalizeAdminAccess(user?.adminAccess, user?.role);
  return normalized.level === "super";
}

export function hasAdminScope(user, scope) {
  const normalizedScope = String(scope || "").trim();
  if (!normalizedScope) return false;
  const normalized = normalizeAdminAccess(user?.adminAccess, user?.role);
  if (!normalized.enabled && normalized.level !== "super") return false;
  if (normalized.level === "super") return true;
  return normalized.scopes.includes(normalizedScope);
}

function toPublicUser(user) {
  if (!user) return null;
  const adminAccess = normalizeAdminAccess(user.adminAccess, user.role);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    sellerId: user.sellerId || null,
    barId: user.barId || null,
    adminAccess,
    isSuperAdmin: adminAccess.level === "super",
    hasAdminAccess: adminAccess.enabled || adminAccess.level === "super",
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
    if (String(user.accountStatus || "active") !== "active") {
      return res.status(403).json({ error: "Account is not active." });
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

export function requireAdminAccess(req, res, next) {
  const user = req.auth?.user || null;
  if (!user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  if (!hasAdminAccess(user)) {
    return res.status(403).json({ error: "Admin access is required." });
  }
  return next();
}

export function requireSuperAdmin(req, res, next) {
  const user = req.auth?.user || null;
  if (!user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  if (!isSuperAdmin(user)) {
    return res.status(403).json({ error: "Super admin access is required." });
  }
  return next();
}

export function requireAdminScope(...allowedScopes) {
  return (req, res, next) => {
    const user = req.auth?.user || null;
    if (!user) {
      return res.status(401).json({ error: "Authentication required." });
    }
    const normalizedScopes = allowedScopes
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    if (normalizedScopes.length === 0) {
      return res.status(500).json({ error: "Server permission scope is not configured." });
    }
    if (normalizedScopes.some((scope) => hasAdminScope(user, scope))) {
      return next();
    }
    return res.status(403).json({ error: "Insufficient admin permissions." });
  };
}

export function requireNonProduction(req, res, next) {
  if (env.nodeEnv === "production") {
    return res.status(403).json({ error: "Endpoint disabled in production." });
  }
  return next();
}
