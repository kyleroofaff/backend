import crypto from "node:crypto";
import { env } from "../config/env.js";
import { buildAuthPayload, signAuthToken } from "../middlewares/auth.js";
import {
  createUser,
  getUserById,
  getUserByEmail,
  setUserEmailVerificationToken,
  updateUserAdminAccessById,
  updateUserCredentialsById,
  verifyUserEmailToken
} from "../repositories/userRepository.js";
import { sendPlatformEmail, sendSellerApprovalRequestEmail } from "../services/mailer.js";
import { dispatchPushNotification } from "../services/pushService.js";
import { hashPassword, verifyPassword } from "../utils/password.js";

function sanitizeUser(user) {
  const rawAdminAccess = user?.adminAccess && typeof user.adminAccess === "object" ? user.adminAccess : {};
  const role = String(user?.role || "").trim().toLowerCase();
  const adminAccess = role === "admin"
    ? { enabled: true, level: "super", scopes: ["*"] }
    : {
        enabled: rawAdminAccess.enabled === true,
        level: rawAdminAccess.level === "super" ? "super" : (rawAdminAccess.enabled === true ? "limited" : "none"),
        scopes: Array.isArray(rawAdminAccess.scopes)
          ? rawAdminAccess.scopes.map((scope) => String(scope || "").trim()).filter(Boolean)
          : []
      };
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    sellerId: user.sellerId || null,
    barId: user.barId || null,
    accountStatus: user.accountStatus || "active",
    emailVerified: user.emailVerified !== false,
    adminAccess,
    isSuperAdmin: adminAccess.level === "super",
    hasAdminAccess: adminAccess.enabled === true || adminAccess.level === "super",
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

function emailVerificationRequiredForRole(role) {
  return ["buyer", "seller", "bar"].includes(String(role || "").trim().toLowerCase());
}

function getEmailVerificationError(user) {
  if (!user) return "Invalid email or password.";
  if (!emailVerificationRequiredForRole(user.role)) return "";
  if (user.emailVerified !== false) return "";
  return "Please verify your email before logging in.";
}

function normalizeRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return ["buyer", "seller", "bar"].includes(normalized) ? normalized : "";
}

function buildSlug(value, fallback) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

function getPrimaryClientOrigin() {
  return String(env.clientOrigin || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean)
    || "http://localhost:5173";
}

function buildVerifyUrl(email, token) {
  const origin = getPrimaryClientOrigin().replace(/\/+$/g, "");
  const encodedEmail = encodeURIComponent(String(email || "").trim().toLowerCase());
  const encodedToken = encodeURIComponent(String(token || "").trim());
  return `${origin}/verify-email?email=${encodedEmail}&token=${encodedToken}`;
}

function getDefaultNotificationPreferences(role) {
  const sellerOrBar = role === "seller" || role === "bar";
  return {
    message: true,
    engagement: true,
    push: {
      message: sellerOrBar,
      engagement: sellerOrBar
    }
  };
}

function getPasswordPolicyError(password) {
  const value = String(password || "");
  const hasPasswordNumber = /\d/.test(value);
  const hasPasswordSymbol = /[^A-Za-z0-9]/.test(value);
  if (value.length < 8 || !hasPasswordNumber || !hasPasswordSymbol) {
    return "Password must be at least 8 characters and include at least 1 number and 1 symbol.";
  }
  return "";
}

async function sendVerificationEmail({ email, name, token }) {
  const verifyUrl = buildVerifyUrl(email, token);
  return sendPlatformEmail({
    toEmail: email,
    toName: name,
    subject: "Verify your email address",
    text: [
      `Hi ${name},`,
      "",
      "Please verify your email to complete registration.",
      verifyUrl,
      "",
      "This link expires in 24 hours."
    ].join("\n"),
    includeDoNotReplyNotice: false
  });
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
  const emailVerificationError = getEmailVerificationError(user);
  if (emailVerificationError) {
    return res.status(403).json({ error: emailVerificationError });
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

export async function register(req, res, next) {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const role = normalizeRole(req.body?.role);
    const city = String(req.body?.city || "").trim();
    const country = String(req.body?.country || "").trim();
    const preferredLanguage = String(req.body?.preferredLanguage || "en").trim().toLowerCase();
    const acceptedRespectfulConduct = req.body?.acceptedRespectfulConduct === true;
    const acceptedNoRefunds = req.body?.acceptedNoRefunds === true;
    const heightCm = role === "seller" ? (Number(req.body?.heightCm) || "") : "";
    const weightKg = role === "seller" ? (Number(req.body?.weightKg) || "") : "";
    const hairColor = role === "seller" ? String(req.body?.hairColor || "").trim() : "";
    const braSize = role === "seller" ? String(req.body?.braSize || "").trim() : "";
    const pantySize = role === "seller" ? String(req.body?.pantySize || "").trim() : "";
    const skipEmailVerificationRequested = req.body?.skipEmailVerification === true;
    const skipEmailVerification =
      env.allowRegistrationSkipEmailVerification === true
      && skipEmailVerificationRequested
      && (role === "seller" || role === "bar");

    if (!role) {
      return res.status(400).json({ error: "role must be buyer, seller, or bar." });
    }
    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, and password are required." });
    }
    if (!email.includes("@")) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    const passwordPolicyError = getPasswordPolicyError(password);
    if (passwordPolicyError) {
      return res.status(400).json({ error: passwordPolicyError });
    }
    if ((role === "seller" || role === "bar") && (!city || !country)) {
      return res.status(400).json({ error: "city and country are required for seller and bar accounts." });
    }
    if (role === "buyer" && (!acceptedRespectfulConduct || !acceptedNoRefunds)) {
      return res.status(400).json({ error: "Buyer terms must be accepted." });
    }
    if (
      skipEmailVerificationRequested
      && (role === "seller" || role === "bar")
      && env.allowRegistrationSkipEmailVerification !== true
    ) {
      return res.status(403).json({
        error:
          "skipEmailVerification is not enabled. Set ALLOW_REGISTRATION_SKIP_EMAIL_VERIFICATION=true in production."
      });
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: "This email is already registered." });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const verifyToken = crypto.randomBytes(24).toString("hex");
    const verifyExpiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24).toISOString();
    const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Sellers normally start as pending; when skipping email verification we activate so JWT auth works.
    const accountStatus =
      role === "seller" ? (skipEmailVerification ? "active" : "pending") : "active";
    const baseSlug = buildSlug(name, role === "bar" ? "new-bar" : "new-user");
    const barId = role === "bar" ? `${baseSlug}-${Math.random().toString(36).slice(2, 6)}` : null;
    const sellerId = role === "seller" ? `${buildSlug(name, "new-seller")}-${Math.random().toString(36).slice(2, 6)}` : null;

    const profileBase = {
      preferredLanguage,
      notificationPreferences: getDefaultNotificationPreferences(role),
      city,
      country,
      acceptedBuyerTermsAt:
        role === "buyer" && acceptedRespectfulConduct && acceptedNoRefunds ? nowIso : undefined,
      sellerApplicationAt: role === "seller" ? nowIso : undefined,
      sellerApplicationStatus: role === "seller" ? (skipEmailVerification ? "active" : "pending") : undefined,
      requestedSellerSlug: role === "seller" ? buildSlug(name, "new-seller") : undefined,
      heightCm: heightCm || undefined,
      weightKg: weightKg || undefined,
      hairColor: hairColor || undefined,
      braSize: braSize || undefined,
      pantySize: pantySize || undefined
    };

    if (skipEmailVerification) {
      Object.assign(profileBase, {
        emailVerified: true
      });
    } else {
      Object.assign(profileBase, {
        emailVerified: false,
        emailVerificationToken: verifyToken,
        emailVerificationExpiresAt: verifyExpiresAt
      });
    }

    await createUser({
      id: userId,
      email,
      name,
      role,
      accountStatus,
      passwordHash: hashPassword(password),
      barId,
      sellerId,
      profile: profileBase
    });

    if (!skipEmailVerification) {
      const emailResult = await sendVerificationEmail({ email, name, token: verifyToken });
      if (!emailResult?.delivered && env.nodeEnv === "production") {
        return res.status(502).json({ error: "Could not send verification email. Please try again." });
      }
    }

    if (role === "seller") {
      await sendSellerApprovalRequestEmail({
        sellerName: name,
        sellerEmail: email,
        requestedAt: nowIso
      }).catch(() => {});
    }
    const adminRecipient = await getUserByEmail(env.adminEmail).catch(() => null);
    if (adminRecipient?.id) {
      const roleLabel = role === "seller" ? "seller" : (role === "bar" ? "bar" : "buyer");
      await dispatchPushNotification({
        userId: adminRecipient.id,
        preferenceType: "adminOps",
        route: "/admin?tab=users",
        titleByLang: {
          en: "New account signup",
          th: "มีผู้สมัครสมาชิกใหม่",
          my: "Account အသစ်စာရင်းသွင်းထားသည်",
          ru: "Новая регистрация аккаунта"
        },
        bodyByLang: {
          en: `${name} signed up as ${roleLabel}.`,
          th: `${name} สมัครเป็น ${roleLabel} แล้ว`,
          my: `${name} သည် ${roleLabel} အဖြစ် စာရင်းသွင်းခဲ့သည်။`,
          ru: `${name} зарегистрировался(ась) как ${roleLabel}.`
        },
        data: {
          kind: "user_signup",
          signupRole: role,
          userEmail: email
        }
      }).catch(() => {});
    }

    if (skipEmailVerification) {
      const created = await getUserByEmail(email);
      if (!created) {
        return res.status(500).json({ error: "Account created but could not load user." });
      }
      const token = signAuthToken(buildAuthPayload(created));
      return res.status(201).json({
        ok: true,
        message: "Account created.",
        token,
        user: sanitizeUser(created)
      });
    }

    return res.status(201).json({
      ok: true,
      message: "Account created. Check your email to verify before login.",
      ...(env.nodeEnv !== "production" ? { verificationToken: verifyToken } : {})
    });
  } catch (error) {
    return next(error);
  }
}

export async function verifyEmail(req, res, next) {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const token = String(req.body?.token || "").trim();
    if (!email || !token) {
      return res.status(400).json({ error: "email and token are required." });
    }
    const result = await verifyUserEmailToken(email, token);
    if (!result.ok) {
      if (result.reason === "expired") {
        return res.status(410).json({ error: "Verification link has expired. Please request a new one." });
      }
      return res.status(400).json({ error: "Invalid verification link." });
    }
    return res.json({
      ok: true,
      message: "Email verified. You can now log in.",
      user: sanitizeUser(result.user)
    });
  } catch (error) {
    return next(error);
  }
}

export async function resendVerificationEmail(req, res, next) {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    const user = await getUserByEmail(email);
    if (!user) {
      return res.json({
        ok: true,
        message: "If this email is registered, a verification link has been sent."
      });
    }
    if (!emailVerificationRequiredForRole(user.role)) {
      return res.json({
        ok: true,
        message: "If this email is registered, a verification link has been sent."
      });
    }
    if (user.emailVerified !== false) {
      return res.json({
        ok: true,
        message: "This account is already verified. You can log in now."
      });
    }

    const verifyToken = crypto.randomBytes(24).toString("hex");
    const verifyExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    await setUserEmailVerificationToken(email, verifyToken, verifyExpiresAt);

    const emailResult = await sendVerificationEmail({
      email,
      name: String(user.name || "there"),
      token: verifyToken
    });
    if (!emailResult?.delivered && env.nodeEnv === "production") {
      return res.status(502).json({ error: "Could not send verification email. Please try again." });
    }
    return res.json({
      ok: true,
      message: "Verification email sent. Please check your inbox."
    });
  } catch (error) {
    return next(error);
  }
}

export async function updateOwnCredentials(req, res, next) {
  try {
    const userId = String(req.auth?.user?.id || "").trim();
    const currentPassword = String(req.body?.currentPassword || "");
    const newEmail = String(req.body?.newEmail || "").trim().toLowerCase();
    const newPassword = String(req.body?.newPassword || "");
    if (!userId) {
      return res.status(401).json({ error: "Authentication required." });
    }
    if (!currentPassword) {
      return res.status(400).json({ error: "Current password is required." });
    }
    if (!newEmail && !newPassword) {
      return res.status(400).json({ error: "Provide a new email or new password." });
    }
    if (newEmail && !newEmail.includes("@")) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    const passwordPolicyError = newPassword ? getPasswordPolicyError(newPassword) : "";
    if (passwordPolicyError) {
      return res.status(400).json({ error: passwordPolicyError });
    }

    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    if (!verifyPassword(currentPassword, user.passwordHash || "")) {
      return res.status(403).json({ error: "Current password is incorrect." });
    }
    try {
      const updated = await updateUserCredentialsById(userId, {
        email: newEmail || undefined,
        passwordHash: newPassword ? hashPassword(newPassword) : undefined
      });
      if (!updated) {
        return res.status(404).json({ error: "User not found." });
      }
      return res.json({
        ok: true,
        message: "Account credentials updated.",
        user: sanitizeUser(updated)
      });
    } catch (error) {
      if (String(error?.message || "").toLowerCase().includes("email already exists")) {
        return res.status(409).json({ error: "This email is already registered." });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
}

export async function updateUserCredentialsByAdmin(req, res, next) {
  try {
    const targetUserId = String(req.params?.userId || "").trim();
    const newEmail = String(req.body?.newEmail || "").trim().toLowerCase();
    const newPassword = String(req.body?.newPassword || "");
    if (!targetUserId) {
      return res.status(400).json({ error: "userId is required." });
    }
    if (!newEmail && !newPassword) {
      return res.status(400).json({ error: "Provide a new email or new password." });
    }
    if (newEmail && !newEmail.includes("@")) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    const passwordPolicyError = newPassword ? getPasswordPolicyError(newPassword) : "";
    if (passwordPolicyError) {
      return res.status(400).json({ error: passwordPolicyError });
    }
    const existing = await getUserById(targetUserId);
    if (!existing) {
      return res.status(404).json({ error: "User not found." });
    }
    try {
      const updated = await updateUserCredentialsById(targetUserId, {
        email: newEmail || undefined,
        passwordHash: newPassword ? hashPassword(newPassword) : undefined
      });
      if (!updated) {
        return res.status(404).json({ error: "User not found." });
      }
      return res.json({
        ok: true,
        message: "User credentials updated.",
        user: sanitizeUser(updated)
      });
    } catch (error) {
      if (String(error?.message || "").toLowerCase().includes("email already exists")) {
        return res.status(409).json({ error: "This email is already registered." });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
}

export async function updateUserAdminAccessBySuperAdmin(req, res, next) {
  try {
    const requesterRole = String(req.auth?.user?.role || "").trim().toLowerCase();
    const requesterIsSuper = requesterRole === "admin" || req.auth?.user?.isSuperAdmin === true;
    if (!requesterIsSuper) {
      return res.status(403).json({ error: "Super admin access is required." });
    }
    const targetUserId = String(req.params?.userId || "").trim();
    const enabled = req.body?.enabled === true;
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
    if (!targetUserId) {
      return res.status(400).json({ error: "userId is required." });
    }
    const target = await getUserById(targetUserId);
    if (!target) {
      return res.status(404).json({ error: "User not found." });
    }
    const targetRole = String(target.role || "").trim().toLowerCase();
    if (!["seller", "bar"].includes(targetRole)) {
      return res.status(400).json({ error: "Admin access can only be assigned to seller or bar accounts." });
    }
    const updated = await updateUserAdminAccessById(targetUserId, {
      enabled,
      level: enabled ? "limited" : "none",
      scopes
    });
    if (!updated) {
      return res.status(404).json({ error: "User not found." });
    }
    return res.json({
      ok: true,
      message: enabled ? "Delegated admin access updated." : "Delegated admin access removed.",
      user: sanitizeUser(updated)
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
