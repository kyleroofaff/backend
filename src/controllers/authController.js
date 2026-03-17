import { buildAuthPayload, signAuthToken } from "../middlewares/auth.js";
import { getUserByEmail } from "../repositories/userRepository.js";
import { verifyPassword } from "../utils/password.js";

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    sellerId: user.sellerId || null,
    barId: user.barId || null,
    accountStatus: user.accountStatus || "active"
  };
}

function getBlockedStatusError(user) {
  if (!user) return "Invalid email or password.";
  if (user.accountStatus === "blocked") return "This account is blocked.";
  if (user.role === "seller" && user.accountStatus === "rejected") return "This seller account was rejected.";
  if (user.role === "seller" && user.accountStatus === "pending") return "This seller account is pending approval.";
  if (user.accountStatus && user.accountStatus !== "active") return "This account is not active.";
  return "";
}

export async function login(req, res, next) {
  try {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required." });
  }

  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash || "")) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  const blockedStatusError = getBlockedStatusError(user);
  if (blockedStatusError) {
    return res.status(403).json({ error: blockedStatusError });
  }

  const token = signAuthToken(buildAuthPayload(user));
  return res.json({
    ok: true,
    token,
    user: sanitizeUser(user)
  });
  } catch (error) {
    return next(error);
  }
}

export function me(req, res) {
  const user = req.auth?.user || null;
  if (!user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  return res.json({ ok: true, user });
}
