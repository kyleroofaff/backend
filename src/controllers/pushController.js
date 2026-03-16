import { updateUserPushPreferences } from "../repositories/userRepository.js";
import {
  deactivatePushSubscription,
  upsertPushSubscription
} from "../repositories/pushRepository.js";
import { getPublicPushConfig } from "../services/pushService.js";

function normalizePushSubscriptionPayload(payload = {}) {
  return {
    endpoint: String(payload?.endpoint || "").trim(),
    p256dh: String(payload?.keys?.p256dh || "").trim(),
    auth: String(payload?.keys?.auth || "").trim()
  };
}

export function pushConfig(_req, res) {
  return res.json({
    ok: true,
    push: getPublicPushConfig()
  });
}

export async function subscribePush(req, res, next) {
  try {
    const userId = req.auth?.user?.id || "";
    const role = req.auth?.user?.role || "";
    const subscription = normalizePushSubscriptionPayload(req.body?.subscription || {});
    if (!userId || !role) {
      return res.status(401).json({ ok: false, error: "Authentication required." });
    }
    if (!subscription.endpoint || !subscription.p256dh || !subscription.auth) {
      return res.status(400).json({ ok: false, error: "Valid push subscription is required." });
    }
    const saved = await upsertPushSubscription({
      userId,
      role,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth
    });
    return res.json({
      ok: true,
      subscription: {
        id: saved?.id || null,
        endpoint: saved?.endpoint || subscription.endpoint,
        isActive: saved?.isActive !== false
      }
    });
  } catch (error) {
    return next(error);
  }
}

export async function unsubscribePush(req, res, next) {
  try {
    const userId = req.auth?.user?.id || "";
    const endpoint = String(req.body?.endpoint || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Authentication required." });
    }
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: "endpoint is required." });
    }
    await deactivatePushSubscription({ userId, endpoint });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

export async function updatePushPreferences(req, res, next) {
  try {
    const userId = req.auth?.user?.id || "";
    const role = req.auth?.user?.role || "";
    const push = req.body?.push || {};
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Authentication required." });
    }
    const patch = {
      ...(push.message === undefined ? {} : { message: Boolean(push.message) }),
      ...(push.engagement === undefined ? {} : { engagement: Boolean(push.engagement) }),
      ...(role === "admin" && push.adminOps !== undefined ? { adminOps: Boolean(push.adminOps) } : {})
    };
    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, error: "At least one push preference key is required." });
    }
    const updatedUser = await updateUserPushPreferences(userId, patch);
    return res.json({
      ok: true,
      notificationPreferences: updatedUser?.notificationPreferences || null
    });
  } catch (error) {
    return next(error);
  }
}
