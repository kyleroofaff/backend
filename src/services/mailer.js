import nodemailer from "nodemailer";
import { env } from "../config/env.js";

const DO_NOT_REPLY_NOTICE = "Do not reply to this email. This inbox is not monitored.";

function withDoNotReplyNotice(text) {
  const baseText = String(text || "").trim();
  if (!baseText) return DO_NOT_REPLY_NOTICE;
  if (baseText.toLowerCase().includes("do not reply")) return baseText;
  return `${baseText}\n\n${DO_NOT_REPLY_NOTICE}`;
}

function getTransport() {
  if (!env.smtpHost || !env.smtpUser || !env.smtpPass) {
    return null;
  }

  return nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass
    }
  });
}

function getEmailMode() {
  const normalized = String(env.emailMode || "").trim().toLowerCase();
  if (["disabled", "test", "live"].includes(normalized)) return normalized;
  return "disabled";
}

function getTestRecipients() {
  return String(env.emailTestRecipients || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeOutboundAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map((entry) => {
      const filename = String(entry?.filename || entry?.name || "").trim();
      const contentType = String(entry?.contentType || entry?.mimeType || "").trim();
      const contentBase64 = String(entry?.contentBase64 || "").trim();
      if (!filename || !contentBase64) return null;
      return {
        filename: filename.slice(0, 160),
        contentType: contentType || "application/octet-stream",
        content: Buffer.from(contentBase64, "base64")
      };
    })
    .filter(Boolean);
}

export async function sendSellerApprovalRequestEmail({ sellerName, sellerEmail, requestedAt }) {
  const transport = getTransport();
  const subject = `Seller approval requested: ${sellerName}`;
  const text = withDoNotReplyNotice([
    "A new seller account is waiting for approval.",
    "",
    `Name: ${sellerName}`,
    `Email: ${sellerEmail}`,
    `Requested at: ${requestedAt}`,
    "",
    "Open the admin dashboard and approve the seller account."
  ].join("\n"));

  if (!transport) {
    console.log(`[email:mock] To: ${env.adminEmail}`);
    console.log(`[email:mock] Subject: ${subject}`);
    console.log(`[email:mock] Body:\n${text}`);
    return { delivered: false, mock: true };
  }

  const sendResult = await transport.sendMail({
    from: env.smtpFrom,
    to: env.adminEmail,
    subject,
    text
  });

  return { delivered: true, mock: false };
}

export async function sendPlatformEmail({
  toEmail,
  toName,
  subject,
  text,
  fromEmail = "",
  replyToEmail = "",
  includeDoNotReplyNotice = true,
  attachments = []
}) {
  const mode = getEmailMode();
  const transport = getTransport();
  const emailText = includeDoNotReplyNotice ? withDoNotReplyNotice(text) : String(text || "").trim();
  const resolvedFromEmail = String(fromEmail || env.smtpFrom || "").trim();
  const resolvedReplyToEmail = String(replyToEmail || "").trim();
  const resolvedTestRecipients = getTestRecipients();
  const normalizedAttachments = normalizeOutboundAttachments(attachments);
  const recipientList =
    mode === "test"
      ? resolvedTestRecipients
      : [String(toEmail || "").trim()].filter(Boolean);

  if (!subject || !emailText || recipientList.length === 0) {
    return {
      delivered: false,
      mock: true,
      mode,
      recipients: recipientList,
      reason: "missing_required_fields"
    };
  }

  if (mode === "disabled") {
    console.log(`[email:disabled] To: ${recipientList.join(", ")}`);
    console.log(`[email:disabled] Subject: ${subject}`);
    return {
      delivered: false,
      mock: true,
      mode,
      recipients: recipientList,
      reason: "disabled_mode"
    };
  }

  if (!transport) {
    console.log(`[email:mock_no_transport] To: ${recipientList.join(", ")}`);
    console.log(`[email:mock_no_transport] Subject: ${subject}`);
    return {
      delivered: false,
      mock: true,
      mode,
      recipients: recipientList,
      reason: "missing_smtp_transport"
    };
  }

  const sendResult = await transport.sendMail({
    from: resolvedFromEmail || env.smtpFrom,
    to: recipientList.join(", "),
    subject,
    text: emailText,
    ...(normalizedAttachments.length
      ? { attachments: normalizedAttachments }
      : {}),
    ...(resolvedReplyToEmail
      ? { replyTo: resolvedReplyToEmail }
      : {}),
    ...(mode === "test"
      ? {
          replyTo: resolvedReplyToEmail || toEmail || undefined
        }
      : {}),
    ...(toName && mode === "live"
      ? {
          to: `"${toName}" <${recipientList[0]}>`
        }
      : {})
  });

  return {
    delivered: true,
    mock: false,
    mode,
    recipients: recipientList,
    messageId: String(sendResult?.messageId || "").trim()
  };
}
