import webPush from "web-push";
import { env } from "../config/env.js";
import { getUserById } from "../repositories/userRepository.js";
import {
  deactivatePushSubscriptionByEndpoint,
  listActivePushSubscriptionsByUserId
} from "../repositories/pushRepository.js";

const SUPPORTED_LANGUAGES = new Set(["en", "th", "my", "ru"]);
let vapidReady = false;

function isPushConfigured() {
  return Boolean(env.vapidPublicKey && env.vapidPrivateKey && env.vapidSubject);
}

function ensureWebPushConfigured() {
  if (!isPushConfigured() || vapidReady) return;
  webPush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  vapidReady = true;
}

function resolveLocalizedText(textByLang = {}, language = "en", fallback = "") {
  const normalizedLang = SUPPORTED_LANGUAGES.has(String(language || "").trim().toLowerCase())
    ? String(language || "").trim().toLowerCase()
    : "en";
  const preferred = String(textByLang?.[normalizedLang] || "").trim();
  if (preferred) return preferred;
  const english = String(textByLang?.en || "").trim();
  if (english) return english;
  return String(fallback || "").trim();
}

function isPushPreferenceEnabled(user, preferenceType) {
  if (!user) return false;
  const prefs = user.notificationPreferences || {};
  const pushPrefs = prefs.push || {};
  if (preferenceType === "message") {
    if (prefs.message === false) return false;
    return pushPrefs.message !== false;
  }
  if (preferenceType === "engagement") {
    if (prefs.engagement === false) return false;
    return pushPrefs.engagement !== false;
  }
  if (preferenceType === "adminOps") {
    if (user.role !== "admin") return false;
    return pushPrefs.adminOps !== false;
  }
  return true;
}

function toWebPushSubscription(subscription) {
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth
    }
  };
}

export async function dispatchPushNotification({
  userId,
  preferenceType = "message",
  route = "/account",
  titleByLang = {},
  bodyByLang = {},
  data = {}
}) {
  if (!isPushConfigured()) {
    return { ok: false, skipped: true, reason: "push_not_configured", sentCount: 0 };
  }

  const user = await getUserById(userId);
  if (!user || user.accountStatus !== "active") {
    return { ok: false, skipped: true, reason: "user_not_available", sentCount: 0 };
  }
  if (!isPushPreferenceEnabled(user, preferenceType)) {
    return { ok: false, skipped: true, reason: "push_preference_disabled", sentCount: 0 };
  }

  const language = SUPPORTED_LANGUAGES.has(String(user.preferredLanguage || "").toLowerCase())
    ? String(user.preferredLanguage || "").toLowerCase()
    : "en";
  const title = resolveLocalizedText(titleByLang, language, "Notification");
  const body = resolveLocalizedText(bodyByLang, language, "");

  const subscriptions = await listActivePushSubscriptionsByUserId(user.id);
  if (!subscriptions.length) {
    return { ok: true, skipped: true, reason: "no_active_subscriptions", sentCount: 0 };
  }

  ensureWebPushConfigured();
  let sentCount = 0;
  for (const subscription of subscriptions) {
    try {
      await webPush.sendNotification(
        toWebPushSubscription(subscription),
        JSON.stringify({
          title,
          body,
          lang: language,
          route,
          data
        })
      );
      sentCount += 1;
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        await deactivatePushSubscriptionByEndpoint(subscription.endpoint);
      }
    }
  }

  return { ok: true, sentCount };
}

export function getPublicPushConfig() {
  return {
    enabled: isPushConfigured(),
    publicKey: env.vapidPublicKey || ""
  };
}
