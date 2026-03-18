import "dotenv/config";

function parseTrustProxyValue(rawValue, nodeEnv) {
  if (rawValue == null || String(rawValue).trim() === "") {
    return nodeEnv === "production" ? 1 : false;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) return true;
  if (["false", "no", "off"].includes(normalized)) return false;
  const asNumber = Number(normalized);
  if (Number.isInteger(asNumber) && asNumber >= 0) return asNumber;
  return String(rawValue).trim();
}

const nodeEnv = process.env.NODE_ENV || "development";

export const env = {
  nodeEnv,
  port: Number(process.env.PORT || 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL || "",
  databaseSslRequire: process.env.DATABASE_SSL_REQUIRE === "true",
  jwtSecret: process.env.JWT_SECRET || "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  adminEmail: process.env.ADMIN_EMAIL || "admin@thailandpanties.com",
  emailMode: process.env.EMAIL_MODE || "disabled",
  emailTestRecipients: process.env.EMAIL_TEST_RECIPIENTS || "",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || "no-reply@thailandpanties.local",
  supportInboxEmail: process.env.SUPPORT_INBOX_EMAIL || "support@thailandpanties.com",
  adminInboxEmail: process.env.ADMIN_INBOX_EMAIL || "admin@thailandpanties.com",
  inboundWebhookToken: process.env.INBOUND_WEBHOOK_TOKEN || "",
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
  vapidSubject: process.env.VAPID_SUBJECT || "",
  trustProxy: parseTrustProxyValue(process.env.TRUST_PROXY, nodeEnv),
  allowLegacyPlaintextPasswords:
    process.env.ALLOW_LEGACY_PLAINTEXT_PASSWORDS === "true"
    || (process.env.ALLOW_LEGACY_PLAINTEXT_PASSWORDS == null && nodeEnv !== "production")
};
