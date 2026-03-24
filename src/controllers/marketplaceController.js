import {
  createPostReportInStateAndSeed,
  createSellerPostInStateAndSeed,
  deleteProductFromStateAndSeed,
  deleteSellerPostFromStateAndSeed,
  getPostReportsState,
  getSellerPostsState,
  getState,
  replaceState,
  replaceStateAndSeed,
  resolvePostReportInStateAndSeed,
  resetState
} from "../db/store.js";
import { sendPlatformEmail, sendSellerApprovalRequestEmail } from "../services/mailer.js";
import { scanAttachmentContentBase64 } from "../services/attachmentScanner.js";
import { dispatchPushNotification } from "../services/pushService.js";
import { getWalletReconciliationSummary } from "../services/reconciliation.js";
import { acceptCustomRequestQuote } from "../services/customRequestPayments.js";
import { payCheckoutWithWallet, topUpWallet } from "../services/walletCommerce.js";
import { createBuyerCustomRequest, sendBuyerPaidMessage } from "../services/buyerMoneyFlows.js";
import { env } from "../config/env.js";
import { getUserById } from "../repositories/userRepository.js";
import { hasPostgresConfig, pgQuery } from "../db/postgres.js";

const SUPPORTED_TRANSLATION_LANGUAGES = new Set(["en", "th", "my", "ru"]);
const PAYOUT_SCHEDULE = "monthly";
const PAYOUT_MIN_THRESHOLD_THB = 100;
const PAYOUT_HOLD_DAYS = 14;
const DEFAULT_PROMPTPAY_RECEIVER_MOBILE = "0812345678";
const PAYOUT_ELIGIBLE_TYPES = new Set(["message_fee", "order_sale_earning", "order_bar_commission"]);
const EMAIL_INBOX_STATUSES = new Set(["open", "pending_customer", "archived"]);
const EMAIL_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const EMAIL_ATTACHMENT_MAX_COUNT = 5;
const EMAIL_ATTACHMENT_MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const EMAIL_HEALTH_EVENT_LIMIT = 120;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/zip"
]);
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  "txt",
  "csv",
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "zip"
]);

function normalizeEmailThreadStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "closed") return "archived";
  if (EMAIL_INBOX_STATUSES.has(normalized)) return normalized;
  return "open";
}

function normalizeMailboxType(value) {
  return String(value || "").trim().toLowerCase() === "support" ? "support" : "admin";
}

function getMailboxAddress(mailbox) {
  const normalized = normalizeMailboxType(mailbox);
  return normalized === "support"
    ? String(env.supportInboxEmail || "support@thailandpanties.com").trim().toLowerCase()
    : String(env.adminInboxEmail || "admin@thailandpanties.com").trim().toLowerCase();
}

function ensureEmailInboxCollections(state) {
  return {
    ...state,
    adminEmailThreads: Array.isArray(state?.adminEmailThreads) ? state.adminEmailThreads : [],
    adminEmailMessages: Array.isArray(state?.adminEmailMessages) ? state.adminEmailMessages : [],
    emailInboxHealth: {
      webhookEvents: Array.isArray(state?.emailInboxHealth?.webhookEvents) ? state.emailInboxHealth.webhookEvents : [],
      lastWebhookAt: String(state?.emailInboxHealth?.lastWebhookAt || "").trim(),
      lastWebhookStatus: String(state?.emailInboxHealth?.lastWebhookStatus || "").trim(),
    },
    emailSuppressions: Array.isArray(state?.emailSuppressions) ? state.emailSuppressions : []
  };
}

function normalizeEmailValue(value) {
  return String(value || "").trim().toLowerCase();
}

function parseRecipientEmails(payload) {
  const values = [];
  if (Array.isArray(payload?.ToFull)) {
    payload.ToFull.forEach((entry) => {
      const email = normalizeEmailValue(entry?.Email || entry?.email);
      if (email) values.push(email);
    });
  }
  String(payload?.To || "")
    .split(",")
    .map((part) => normalizeEmailValue(part))
    .filter(Boolean)
    .forEach((value) => values.push(value));
  const originalRecipient = normalizeEmailValue(payload?.OriginalRecipient);
  if (originalRecipient) values.push(originalRecipient);
  return [...new Set(values)];
}

function resolveMailboxFromRecipients(recipients) {
  const supportAddress = getMailboxAddress("support");
  if ((recipients || []).some((value) => value === supportAddress)) return "support";
  return "admin";
}

function buildThreadSnippet(textBody) {
  const compact = String(textBody || "").replace(/\s+/g, " ").trim();
  return compact.slice(0, 240);
}

function normalizeThreadSubject(subject) {
  return String(subject || "")
    .trim()
    .toLowerCase()
    .replace(/^(re|fwd?)\s*:\s*/i, "")
    .trim();
}

function isReplySubject(subject) {
  return /^(re|fwd?)\s*:/i.test(String(subject || "").trim());
}

function parseInboundAttachments(payload) {
  if (!Array.isArray(payload?.Attachments)) return [];
  let totalBytes = 0;
  return payload.Attachments.map((entry, index) => {
    const filename = String(entry?.Name || entry?.Filename || `attachment-${index + 1}`).trim() || `attachment-${index + 1}`;
    const contentType = String(entry?.ContentType || "application/octet-stream").trim() || "application/octet-stream";
    const contentBase64 = String(entry?.Content || "").trim();
    const declaredLength = Number(entry?.ContentLength || 0);
    const sizeBytes = Number.isFinite(declaredLength) && declaredLength > 0
      ? declaredLength
      : Math.floor((contentBase64.length * 3) / 4);
    const extension = String(filename.split(".").pop() || "").trim().toLowerCase();
    const allowedByMime = ALLOWED_ATTACHMENT_MIME_TYPES.has(contentType.toLowerCase());
    const allowedByExt = ALLOWED_ATTACHMENT_EXTENSIONS.has(extension);
    const typeAllowed = allowedByMime && allowedByExt;
    const withinSingleLimit = Number.isFinite(sizeBytes) && sizeBytes > 0 && sizeBytes <= EMAIL_ATTACHMENT_MAX_BYTES;
    totalBytes += Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
    const withinTotalLimit = totalBytes <= EMAIL_ATTACHMENT_MAX_TOTAL_BYTES;
    const withinCountLimit = index < EMAIL_ATTACHMENT_MAX_COUNT;
    const blockedReason = !withinCountLimit
      ? "too_many_attachments"
      : (!typeAllowed
        ? "disallowed_type"
        : (!withinSingleLimit
          ? "file_too_large"
          : (!withinTotalLimit ? "total_size_exceeded" : "")));
    const keepContent = !blockedReason;
    return {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      filename: filename.slice(0, 180),
      contentType,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
      contentBase64: keepContent ? contentBase64 : "",
      blockedReason: blockedReason || "",
      scanStatus: keepContent ? "not_scanned" : "blocked"
    };
  }).filter((entry) => entry.contentBase64 || entry.blockedReason);
}

function sanitizeOutboundAttachments(input) {
  if (!Array.isArray(input)) return { ok: true, attachments: [] };
  if (input.length > EMAIL_ATTACHMENT_MAX_COUNT) {
    return { ok: false, error: `Maximum ${EMAIL_ATTACHMENT_MAX_COUNT} attachments are allowed.` };
  }
  const attachments = [];
  let totalBytes = 0;
  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index];
    const filename = String(entry?.filename || entry?.name || "").trim();
    const contentType = String(entry?.contentType || "application/octet-stream").trim() || "application/octet-stream";
    const contentBase64 = String(entry?.contentBase64 || "").trim();
    if (!filename || !contentBase64) {
      return { ok: false, error: "Attachment filename and content are required." };
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(contentBase64)) {
      return { ok: false, error: `Attachment "${filename}" has invalid base64 content.` };
    }
    const extension = String(filename.split(".").pop() || "").trim().toLowerCase();
    const allowedByMime = ALLOWED_ATTACHMENT_MIME_TYPES.has(contentType.toLowerCase());
    const allowedByExt = ALLOWED_ATTACHMENT_EXTENSIONS.has(extension);
    if (!allowedByMime || !allowedByExt) {
      return {
        ok: false,
        error: `Attachment "${filename}" is not allowed. Allowed types: ${[...ALLOWED_ATTACHMENT_EXTENSIONS].join(", ")}.`
      };
    }
    const sizeBytes = Math.floor((contentBase64.length * 3) / 4);
    if (sizeBytes > EMAIL_ATTACHMENT_MAX_BYTES) {
      return { ok: false, error: `Attachment "${filename}" exceeds ${Math.round(EMAIL_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB.` };
    }
    totalBytes += sizeBytes;
    if (totalBytes > EMAIL_ATTACHMENT_MAX_TOTAL_BYTES) {
      return { ok: false, error: `Total attachments exceed ${Math.round(EMAIL_ATTACHMENT_MAX_TOTAL_BYTES / (1024 * 1024))}MB.` };
    }
    attachments.push({
      filename: filename.slice(0, 180),
      contentType,
      contentBase64,
      sizeBytes,
      blockedReason: "",
      scanStatus: "not_scanned"
    });
  }
  return { ok: true, attachments };
}

async function applyAttachmentScanningPolicy(attachments, { dropContentOnMalicious = true } = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return {
      ok: true,
      attachments: [],
      blockedCount: 0,
      maliciousCount: 0,
      scanErrorCount: 0
    };
  }
  const nextAttachments = [];
  let blockedCount = 0;
  let maliciousCount = 0;
  let scanErrorCount = 0;
  for (const attachment of attachments) {
    const baseAttachment = {
      ...attachment,
      blockedReason: String(attachment?.blockedReason || "").trim(),
      scanStatus: String(attachment?.scanStatus || "unknown").trim() || "unknown"
    };
    if (baseAttachment.blockedReason || !String(baseAttachment.contentBase64 || "").trim()) {
      blockedCount += 1;
      nextAttachments.push({
        ...baseAttachment,
        contentBase64: "",
        scanStatus: baseAttachment.scanStatus || "blocked"
      });
      continue;
    }
    const scanResult = await scanAttachmentContentBase64(baseAttachment.contentBase64);
    if (scanResult.status === "clean" || scanResult.status === "not_scanned") {
      nextAttachments.push({
        ...baseAttachment,
        scanStatus: scanResult.status
      });
      continue;
    }
    if (scanResult.status === "malicious") {
      maliciousCount += 1;
      blockedCount += 1;
      nextAttachments.push({
        ...baseAttachment,
        contentBase64: dropContentOnMalicious ? "" : baseAttachment.contentBase64,
        blockedReason: scanResult.signature
          ? `malware_detected:${scanResult.signature}`
          : "malware_detected",
        scanStatus: "malicious"
      });
      continue;
    }
    scanErrorCount += 1;
    if (env.attachmentScanBlockOnError) {
      blockedCount += 1;
      nextAttachments.push({
        ...baseAttachment,
        contentBase64: "",
        blockedReason: "scan_error",
        scanStatus: "error"
      });
    } else {
      nextAttachments.push({
        ...baseAttachment,
        scanStatus: "error"
      });
    }
  }
  return {
    ok: true,
    attachments: nextAttachments,
    blockedCount,
    maliciousCount,
    scanErrorCount
  };
}

function appendWebhookHealthEvent(state, event) {
  const now = new Date().toISOString();
  const nextEvent = {
    id: `webhook_evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at: now,
    ...event
  };
  const events = [nextEvent, ...(state.emailInboxHealth?.webhookEvents || [])].slice(0, EMAIL_HEALTH_EVENT_LIMIT);
  return {
    ...state,
    emailInboxHealth: {
      webhookEvents: events,
      lastWebhookAt: now,
      lastWebhookStatus: String(event?.status || "ok")
    }
  };
}

function findEmailSuppression(state, emailValue) {
  const email = normalizeEmailValue(emailValue);
  if (!email) return null;
  return (state.emailSuppressions || []).find((entry) => normalizeEmailValue(entry?.email) === email) || null;
}

function sanitizeAttachmentForList(attachment) {
  return {
    id: String(attachment?.id || "").trim(),
    filename: String(attachment?.filename || "attachment").trim() || "attachment",
    contentType: String(attachment?.contentType || "application/octet-stream").trim() || "application/octet-stream",
    sizeBytes: Number(attachment?.sizeBytes || 0),
    hasContent: Boolean(String(attachment?.contentBase64 || "").trim()),
    blockedReason: String(attachment?.blockedReason || "").trim(),
    scanStatus: String(attachment?.scanStatus || "unknown").trim()
  };
}

function sanitizeInboxMessageForList(message) {
  const attachments = Array.isArray(message?.attachments)
    ? message.attachments.map(sanitizeAttachmentForList)
    : [];
  return {
    ...message,
    attachments
  };
}

function normalizePayoutMethod(method) {
  const normalized = String(method || "").trim().toLowerCase();
  if (["bank_transfer", "promptpay", "other"].includes(normalized)) return normalized;
  return "bank_transfer";
}

function getMonthRangeFromValue(monthValue) {
  const value = String(monthValue || "").trim();
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const periodStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return {
    periodLabel: periodStart.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    periodStartIso: periodStart.toISOString(),
    periodEndIso: periodEnd.toISOString()
  };
}

function ensureAdminCollections(state) {
  return {
    ...state,
    siteSettings: {
      promptPayReceiverMobile: String(state?.siteSettings?.promptPayReceiverMobile || DEFAULT_PROMPTPAY_RECEIVER_MOBILE).trim() || DEFAULT_PROMPTPAY_RECEIVER_MOBILE
    },
    payoutRuns: Array.isArray(state?.payoutRuns) ? state.payoutRuns : [],
    payoutItems: Array.isArray(state?.payoutItems) ? state.payoutItems : [],
    payoutEvents: Array.isArray(state?.payoutEvents) ? state.payoutEvents : [],
    notifications: Array.isArray(state?.notifications) ? state.notifications : [],
    walletTransactions: Array.isArray(state?.walletTransactions) ? state.walletTransactions : [],
    users: Array.isArray(state?.users) ? state.users : []
  };
}

function isEligiblePayoutWalletTransaction(entry, recipient) {
  if (!entry?.id || !recipient?.id) return false;
  if (!["seller", "bar"].includes(recipient.role)) return false;
  const amount = Number(entry.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (!PAYOUT_ELIGIBLE_TYPES.has(String(entry.type || ""))) return false;
  const createdAtMs = new Date(entry.createdAt || 0).getTime();
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return false;
  return true;
}

export function health(_req, res) {
  res.json({
    ok: true,
    service: "thailand-panties-service",
    timestamp: new Date().toISOString()
  });
}

export async function readiness(_req, res) {
  const checks = {
    api: "ok",
    auth: env.jwtSecret ? "configured" : "missing_jwt_secret"
  };
  if (!env.jwtSecret) {
    return res.status(503).json({
      ok: false,
      checks
    });
  }
  try {
    const summary = await getWalletReconciliationSummary();
    checks.wallet_reconciliation = summary.expectedTypeImbalances.length ? "warning" : "ok";
    return res.json({
      ok: true,
      checks,
      walletReconciliation: {
        source: summary.source,
        rowsAnalysed: summary.rowsAnalysed,
        expectedTypeImbalances: summary.expectedTypeImbalances
      }
    });
  } catch {
    return res.status(503).json({
      ok: false,
      checks: {
        ...checks,
        wallet_reconciliation: "error"
      }
    });
  }
}

export function getBootstrap(_req, res) {
  const state = getState();
  const sanitizedUsers = (state.users || []).map((user) => {
    const { password, passwordHash, ...safeUser } = user || {};
    return safeUser;
  });
  res.json({
    db: {
      ...state,
      users: sanitizedUsers
    }
  });
}

export function saveState(req, res) {
  const incoming = req.body?.db;
  if (!incoming || typeof incoming !== "object") {
    return res.status(400).json({ error: "Expected payload format: { db: {...} }" });
  }

  const state = replaceState(incoming);
  return res.json({
    ok: true,
    counts: {
      users: state.users?.length || 0,
      sellers: state.sellers?.length || 0,
      products: state.products?.length || 0,
      orders: state.orders?.length || 0
    }
  });
}

export function reset(req, res) {
  if (req.query.confirm !== "yes") {
    return res.status(400).json({ error: "Add ?confirm=yes to reset state." });
  }
  const state = resetState();
  return res.json({ ok: true, db: state });
}

export function updatePromptPayReceiver(req, res) {
  const state = ensureAdminCollections(getState());
  const sanitized = String(req.body?.promptPayReceiverMobile || "").replace(/[^\d+]/g, "").trim();
  if (!sanitized) {
    return res.status(400).json({ ok: false, error: "PromptPay mobile number is required." });
  }
  const nextState = {
    ...state,
    siteSettings: {
      ...state.siteSettings,
      promptPayReceiverMobile: sanitized
    }
  };
  replaceState(nextState);
  return res.json({ ok: true, message: "PromptPay receiver saved.", db: nextState });
}

export function createMonthlyPayoutRun(req, res) {
  if (PAYOUT_SCHEDULE !== "monthly") {
    return res.status(400).json({ ok: false, error: "Unsupported payout schedule." });
  }
  const state = ensureAdminCollections(getState());
  const monthValue = req.body?.monthValue;
  const notes = String(req.body?.notes || "").trim();
  const monthRange = getMonthRangeFromValue(monthValue);
  if (!monthRange) {
    return res.status(400).json({ ok: false, error: "Select a valid month (YYYY-MM)." });
  }
  const existingRun = state.payoutRuns.find((run) => (
    run?.periodStart === monthRange.periodStartIso
    && run?.periodEnd === monthRange.periodEndIso
    && run?.status !== "cancelled"
  ));
  if (existingRun) {
    return res.status(409).json({ ok: false, error: `A payout run already exists for ${monthRange.periodLabel}.` });
  }

  const now = new Date().toISOString();
  const holdCutoffMs = Date.now() - (PAYOUT_HOLD_DAYS * 24 * 60 * 60 * 1000);
  const periodStartMs = new Date(monthRange.periodStartIso).getTime();
  const periodEndMs = new Date(monthRange.periodEndIso).getTime();
  const userByIdMap = Object.fromEntries(state.users.map((user) => [user.id, user]));
  const paidSourceTxIds = new Set();
  state.payoutItems.forEach((item) => {
    if (item?.status !== "sent") return;
    (item?.sourceTxIds || []).forEach((txId) => {
      if (txId) paidSourceTxIds.add(String(txId));
    });
  });
  const groupedByRecipient = {};
  state.walletTransactions.forEach((entry) => {
    const recipient = userByIdMap[entry.userId];
    if (!isEligiblePayoutWalletTransaction(entry, recipient)) return;
    if (paidSourceTxIds.has(String(entry.id))) return;
    const createdAtMs = new Date(entry.createdAt || 0).getTime();
    if (!Number.isFinite(createdAtMs) || createdAtMs < periodStartMs || createdAtMs > periodEndMs) return;
    if (createdAtMs > holdCutoffMs) return;
    if (!groupedByRecipient[entry.userId]) {
      groupedByRecipient[entry.userId] = {
        recipientUserId: entry.userId,
        recipientRole: recipient.role,
        sourceTxIds: [],
        grossEligible: 0
      };
    }
    groupedByRecipient[entry.userId].sourceTxIds.push(String(entry.id));
    groupedByRecipient[entry.userId].grossEligible = Number(
      (groupedByRecipient[entry.userId].grossEligible + Number(entry.amount || 0)).toFixed(2)
    );
  });
  const runId = `payout_run_${Date.now()}`;
  const holdUntilMs = new Date(monthRange.periodEndIso).getTime() + (PAYOUT_HOLD_DAYS * 24 * 60 * 60 * 1000);
  const payoutItemsForRun = Object.values(groupedByRecipient).map((entry, index) => {
    const netPayable = Number((entry.grossEligible || 0).toFixed(2));
    const status = netPayable >= PAYOUT_MIN_THRESHOLD_THB ? "ready" : "skipped_below_threshold";
    return {
      id: `payout_item_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
      runId,
      recipientUserId: entry.recipientUserId,
      recipientRole: entry.recipientRole,
      currency: "THB",
      grossEligible: netPayable,
      threshold: PAYOUT_MIN_THRESHOLD_THB,
      netPayable,
      status,
      method: "bank_transfer",
      externalReference: "",
      paidAt: "",
      paidByUserId: "",
      notes: "",
      sourceTxIds: entry.sourceTxIds,
      createdAt: now
    };
  });
  const payoutRun = {
    id: runId,
    schedule: PAYOUT_SCHEDULE,
    periodLabel: monthRange.periodLabel,
    periodStart: monthRange.periodStartIso,
    periodEnd: monthRange.periodEndIso,
    holdUntil: new Date(holdUntilMs).toISOString(),
    status: "processing",
    createdByUserId: req.auth?.user?.id || "",
    createdAt: now,
    completedAt: "",
    notes
  };
  const payoutEventsForRun = payoutItemsForRun.map((item) => ({
    id: `payout_evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    payoutItemId: item.id,
    eventType: "created",
    actorUserId: req.auth?.user?.id || "",
    createdAt: now,
    payload: {
      runId,
      amount: item.netPayable,
      status: item.status,
      sourceTxCount: (item.sourceTxIds || []).length
    }
  }));
  const nextState = {
    ...state,
    payoutRuns: [payoutRun, ...state.payoutRuns],
    payoutItems: [...payoutItemsForRun, ...state.payoutItems],
    payoutEvents: [...payoutEventsForRun, ...state.payoutEvents]
  };
  replaceState(nextState);
  return res.json({
    ok: true,
    runId,
    message: `Created ${monthRange.periodLabel} payout run with ${payoutItemsForRun.length} item(s).`,
    db: nextState
  });
}

export function markPayoutItemSent(req, res) {
  const state = ensureAdminCollections(getState());
  const payoutItemId = String(req.params.payoutItemId || "").trim();
  const normalizedReference = String(req.body?.externalReference || "").trim();
  const method = normalizePayoutMethod(req.body?.method);
  const notes = String(req.body?.notes || "").trim();
  if (!payoutItemId) {
    return res.status(400).json({ ok: false, error: "payoutItemId is required." });
  }
  if (!normalizedReference) {
    return res.status(400).json({ ok: false, error: "Transfer reference is required before marking sent." });
  }
  const idx = state.payoutItems.findIndex((item) => item.id === payoutItemId);
  if (idx < 0) {
    return res.status(404).json({ ok: false, error: "Payout item not found." });
  }
  const item = state.payoutItems[idx];
  if (item?.status === "sent") {
    return res.status(409).json({ ok: false, error: "This payout item is already marked as sent." });
  }
  const recipient = state.users.find((user) => user.id === item.recipientUserId);
  if (!recipient || !["seller", "bar"].includes(recipient.role)) {
    return res.status(400).json({ ok: false, error: "Recipient is invalid for payout." });
  }
  const now = new Date().toISOString();
  const updatedItem = {
    ...item,
    status: "sent",
    method,
    externalReference: normalizedReference,
    notes,
    paidAt: now,
    paidByUserId: req.auth?.user?.id || ""
  };
  const nextPayoutItems = [...state.payoutItems];
  nextPayoutItems[idx] = updatedItem;
  const runHasPendingReady = nextPayoutItems.some((row) => row.runId === item.runId && row.status === "ready");
  const nextPayoutRuns = state.payoutRuns.map((run) => (
    run.id !== item.runId
      ? run
      : {
          ...run,
          status: runHasPendingReady ? "processing" : "completed",
          completedAt: runHasPendingReady ? (run.completedAt || "") : now
        }
  ));
  const eventRow = {
    id: `payout_evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    payoutItemId: updatedItem.id,
    eventType: "marked_sent",
    actorUserId: req.auth?.user?.id || "",
    createdAt: now,
    payload: {
      method,
      reference: normalizedReference,
      notes,
      amount: updatedItem.netPayable
    }
  };
  const nextState = {
    ...state,
    payoutRuns: nextPayoutRuns,
    payoutItems: nextPayoutItems,
    payoutEvents: [eventRow, ...state.payoutEvents],
    notifications: [
      {
        id: `notif_payout_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: updatedItem.recipientUserId,
        type: "engagement",
        text: `Payout sent: THB ${Number(updatedItem.netPayable || 0).toFixed(2)}. Ref ${normalizedReference}.`,
        read: false,
        createdAt: now
      },
      ...state.notifications
    ]
  };
  replaceState(nextState);
  return res.json({ ok: true, message: `Marked payout sent to ${recipient.name || recipient.id}.`, db: nextState });
}

export function markPayoutItemFailed(req, res) {
  const state = ensureAdminCollections(getState());
  const payoutItemId = String(req.params.payoutItemId || "").trim();
  const reason = String(req.body?.reason || "").trim();
  if (!payoutItemId) {
    return res.status(400).json({ ok: false, error: "payoutItemId is required." });
  }
  const idx = state.payoutItems.findIndex((item) => item.id === payoutItemId);
  if (idx < 0) {
    return res.status(404).json({ ok: false, error: "Payout item not found." });
  }
  const item = state.payoutItems[idx];
  if (item?.status === "sent") {
    return res.status(409).json({ ok: false, error: "Sent payout items cannot be marked failed." });
  }
  const now = new Date().toISOString();
  const updatedItem = {
    ...item,
    status: "failed",
    notes: reason || item?.notes || "",
    paidAt: "",
    paidByUserId: req.auth?.user?.id || ""
  };
  const nextPayoutItems = [...state.payoutItems];
  nextPayoutItems[idx] = updatedItem;
  const runHasPendingReady = nextPayoutItems.some((row) => row.runId === item.runId && row.status === "ready");
  const nextPayoutRuns = state.payoutRuns.map((run) => (
    run.id !== item.runId
      ? run
      : {
          ...run,
          status: runHasPendingReady ? "processing" : "completed",
          completedAt: runHasPendingReady ? (run.completedAt || "") : now
        }
  ));
  const eventRow = {
    id: `payout_evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    payoutItemId: updatedItem.id,
    eventType: "marked_failed",
    actorUserId: req.auth?.user?.id || "",
    createdAt: now,
    payload: {
      reason: updatedItem.notes || "manual_failure",
      amount: updatedItem.netPayable
    }
  };
  const nextState = {
    ...state,
    payoutRuns: nextPayoutRuns,
    payoutItems: nextPayoutItems,
    payoutEvents: [eventRow, ...state.payoutEvents]
  };
  replaceState(nextState);
  return res.json({ ok: true, message: "Marked payout item as failed.", db: nextState });
}

export async function ingestPostmarkInboundEmail(req, res) {
  const configuredToken = String(env.inboundWebhookToken || "").trim();
  const providedToken = String(
    req.get("x-inbound-webhook-token")
    || req.query?.token
    || req.body?.token
    || ""
  ).trim();
  if (!configuredToken) {
    return res.status(503).json({ ok: false, error: "Inbound webhook token is not configured." });
  }
  if (!providedToken || providedToken !== configuredToken) {
    const deniedState = appendWebhookHealthEvent(
      ensureEmailInboxCollections(ensureAdminCollections(getState())),
      { status: "denied", error: "invalid_token" }
    );
    replaceState(deniedState);
    return res.status(403).json({ ok: false, error: "Invalid webhook token." });
  }

  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const now = new Date().toISOString();
  const fromEmail = normalizeEmailValue(req.body?.FromFull?.Email || req.body?.From || req.body?.Sender || "");
  const fromName = String(req.body?.FromName || req.body?.FromFull?.Name || "").trim();
  const subject = String(req.body?.Subject || "(No subject)").trim() || "(No subject)";
  const textBody = String(req.body?.TextBody || req.body?.Text || "").trim();
  const htmlBody = String(req.body?.HtmlBody || "").trim();
  const externalMessageId = String(req.body?.MessageID || req.body?.MessageId || "").trim();
  const externalInReplyTo = String(req.body?.InReplyTo || "").trim();
  const recipients = parseRecipientEmails(req.body);
  const mailbox = resolveMailboxFromRecipients(recipients);
  const mailboxAddress = getMailboxAddress(mailbox);
  const inboundAttachmentsParsed = parseInboundAttachments(req.body);
  const inboundAttachmentPolicy = await applyAttachmentScanningPolicy(inboundAttachmentsParsed, { dropContentOnMalicious: true });
  const inboundAttachments = inboundAttachmentPolicy.attachments;

  if (!fromEmail) {
    const failedState = appendWebhookHealthEvent(state, {
      status: "error",
      error: "missing_sender",
      mailbox,
      externalMessageId
    });
    replaceState(failedState);
    return res.status(400).json({ ok: false, error: "Inbound payload missing sender email." });
  }

  const existingMessageByExternalId = externalMessageId
    ? (state.adminEmailMessages || []).find((entry) => entry?.externalMessageId === externalMessageId)
    : null;
  if (existingMessageByExternalId) {
    const duplicateState = appendWebhookHealthEvent(state, {
      status: "duplicate",
      mailbox,
      fromEmail,
      externalMessageId
    });
    replaceState(duplicateState);
    return res.json({ ok: true, duplicate: true });
  }

  let targetThread = null;
  if (externalInReplyTo) {
    const referencedMessage = (state.adminEmailMessages || []).find((entry) => entry?.externalMessageId === externalInReplyTo);
    if (referencedMessage) {
      targetThread = (state.adminEmailThreads || []).find((entry) => entry.id === referencedMessage.threadId) || null;
    }
  }
  const shouldThreadAsReply = Boolean(externalInReplyTo) || isReplySubject(subject);
  if (!targetThread && shouldThreadAsReply) {
    const normalizedIncomingSubject = normalizeThreadSubject(subject);
    targetThread = (state.adminEmailThreads || []).find((entry) => (
      normalizeMailboxType(entry?.mailbox) === mailbox
      && normalizeEmailValue(entry?.participantEmail) === fromEmail
      && normalizeThreadSubject(entry?.lastSubject) === normalizedIncomingSubject
      && normalizeEmailThreadStatus(entry?.status) !== "archived"
    )) || null;
  }

  const threadId = targetThread?.id || `email_thread_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const inboundMessageId = `email_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const nextMessage = {
    id: inboundMessageId,
    threadId,
    mailbox,
    direction: "inbound",
    fromEmail,
    fromName,
    toEmail: mailboxAddress,
    subject,
    text: textBody,
    html: htmlBody,
    attachments: inboundAttachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      contentBase64: attachment.contentBase64,
      blockedReason: attachment.blockedReason || "",
      scanStatus: attachment.scanStatus || "unknown"
    })),
    externalMessageId: externalMessageId || "",
    externalInReplyTo: externalInReplyTo || "",
    delivery: {
      status: "received",
      provider: "postmark",
      direction: "inbound",
      receivedAt: now
    },
    createdAt: now
  };

  const baseThread = targetThread || {
    id: threadId,
    mailbox,
    participantEmail: fromEmail,
    participantName: fromName || fromEmail,
    status: "open",
    unreadCount: 0,
    createdAt: now
  };
  const nextThread = {
    ...baseThread,
    mailbox,
    participantEmail: fromEmail,
    participantName: fromName || baseThread.participantName || fromEmail,
    status: "open",
    unreadCount: Number(baseThread.unreadCount || 0) + 1,
    lastMessageAt: now,
    lastMessageDirection: "inbound",
    lastSubject: subject,
    lastSnippet: buildThreadSnippet(textBody),
    updatedAt: now
  };

  const nextStateBase = {
    ...state,
    adminEmailThreads: [
      nextThread,
      ...(state.adminEmailThreads || []).filter((entry) => entry.id !== threadId)
    ].slice(0, 2000),
    adminEmailMessages: [
      ...(state.adminEmailMessages || []),
      nextMessage
    ].slice(-12000)
  };
  const nextState = appendWebhookHealthEvent(nextStateBase, {
    status: "ok",
    mailbox,
    fromEmail,
    externalMessageId: externalMessageId || null,
    threadId
  });
  replaceState(nextState);
  return res.json({ ok: true, threadId, messageId: inboundMessageId });
}

export function getAdminEmailInboxThreads(_req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const mailboxFilter = String(_req.query?.mailbox || "all").trim().toLowerCase();
  const statusFilterRaw = String(_req.query?.status || "all").trim().toLowerCase();
  const statusFilter = statusFilterRaw === "all"
    ? "all"
    : (statusFilterRaw === "active" ? "active" : normalizeEmailThreadStatus(statusFilterRaw));
  const search = String(_req.query?.search || "").trim().toLowerCase();
  const sorted = [...(state.adminEmailThreads || [])].sort(
    (a, b) => new Date(b.lastMessageAt || b.createdAt || 0).getTime() - new Date(a.lastMessageAt || a.createdAt || 0).getTime()
  );
  const filtered = sorted.filter((thread) => {
    const normalizedThreadStatus = normalizeEmailThreadStatus(thread?.status);
    if (mailboxFilter !== "all" && normalizeMailboxType(thread?.mailbox) !== mailboxFilter) return false;
    if (statusFilter === "active" && !["open", "pending_customer"].includes(normalizedThreadStatus)) return false;
    if (statusFilter !== "all" && statusFilter !== "active" && normalizedThreadStatus !== statusFilter) return false;
    if (!search) return true;
    const haystack = [
      thread?.participantEmail,
      thread?.participantName,
      thread?.lastSubject,
      thread?.lastSnippet
    ].map((value) => String(value || "").toLowerCase()).join(" ");
    return haystack.includes(search);
  });
  return res.json({ ok: true, threads: filtered });
}

export function getAdminEmailInboxThreadMessages(req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const threadId = String(req.params.threadId || "").trim();
  if (!threadId) return res.status(400).json({ ok: false, error: "threadId is required." });
  const thread = (state.adminEmailThreads || []).find((entry) => entry.id === threadId);
  if (!thread) return res.status(404).json({ ok: false, error: "Email thread not found." });
  const messages = (state.adminEmailMessages || [])
    .filter((entry) => entry.threadId === threadId)
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
    .map(sanitizeInboxMessageForList);
  return res.json({ ok: true, thread, messages });
}

export function downloadAdminEmailInboxAttachment(req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const threadId = String(req.params.threadId || "").trim();
  const messageId = String(req.params.messageId || "").trim();
  const attachmentId = String(req.params.attachmentId || "").trim();
  if (!threadId || !messageId || !attachmentId) {
    return res.status(400).json({ ok: false, error: "threadId, messageId, and attachmentId are required." });
  }
  const thread = (state.adminEmailThreads || []).find((entry) => entry.id === threadId);
  if (!thread) return res.status(404).json({ ok: false, error: "Email thread not found." });
  const message = (state.adminEmailMessages || []).find((entry) => entry.id === messageId && entry.threadId === threadId);
  if (!message) return res.status(404).json({ ok: false, error: "Email message not found." });
  const attachment = (Array.isArray(message.attachments) ? message.attachments : [])
    .find((entry) => String(entry?.id || "").trim() === attachmentId);
  if (!attachment) return res.status(404).json({ ok: false, error: "Attachment not found." });
  const contentBase64 = String(attachment?.contentBase64 || "").trim();
  if (!contentBase64) {
    return res.status(404).json({ ok: false, error: "Attachment content is not retained." });
  }
  const filename = String(attachment?.filename || "attachment").trim() || "attachment";
  const contentType = String(attachment?.contentType || "application/octet-stream").trim() || "application/octet-stream";
  let buffer;
  try {
    buffer = Buffer.from(contentBase64, "base64");
  } catch {
    return res.status(500).json({ ok: false, error: "Attachment content could not be decoded." });
  }
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  return res.send(buffer);
}

export function getAdminEmailInboxHealth(_req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const events = state.emailInboxHealth?.webhookEvents || [];
  const okEvents = events.filter((entry) => entry.status === "ok").length;
  const deniedEvents = events.filter((entry) => entry.status === "denied").length;
  const duplicateEvents = events.filter((entry) => entry.status === "duplicate").length;
  const errorEvents = events.filter((entry) => entry.status === "error").length;
  return res.json({
    ok: true,
    webhook: {
      lastWebhookAt: state.emailInboxHealth?.lastWebhookAt || null,
      lastWebhookStatus: state.emailInboxHealth?.lastWebhookStatus || null,
      totals: {
        ok: okEvents,
        denied: deniedEvents,
        duplicate: duplicateEvents,
        error: errorEvents
      },
      recentEvents: events.slice(0, 20)
    }
  });
}

export function listEmailSuppressions(_req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const suppressions = [...(state.emailSuppressions || [])].sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
  return res.json({ ok: true, suppressions });
}

export function upsertEmailSuppression(req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const email = normalizeEmailValue(req.body?.email);
  const reason = String(req.body?.reason || "manual_suppression").trim().slice(0, 240) || "manual_suppression";
  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, error: "Valid email is required." });
  }
  const actorUserId = String(req.auth?.user?.id || "").trim() || null;
  const now = new Date().toISOString();
  const existing = findEmailSuppression(state, email);
  const nextSuppression = existing
    ? { ...existing, reason, updatedAt: now, updatedByUserId: actorUserId }
    : {
        id: `email_sup_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        email,
        reason,
        createdAt: now,
        createdByUserId: actorUserId,
        updatedAt: now,
        updatedByUserId: actorUserId
      };
  const nextState = {
    ...state,
    emailSuppressions: [
      nextSuppression,
      ...(state.emailSuppressions || []).filter((entry) => normalizeEmailValue(entry?.email) !== email)
    ]
  };
  replaceState(nextState);
  return res.json({ ok: true, suppression: nextSuppression });
}

export function removeEmailSuppression(req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const email = normalizeEmailValue(req.params?.email || "");
  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, error: "Valid email is required." });
  }
  const existing = findEmailSuppression(state, email);
  if (!existing) {
    return res.status(404).json({ ok: false, error: "Suppression not found." });
  }
  const nextState = {
    ...state,
    emailSuppressions: (state.emailSuppressions || []).filter((entry) => normalizeEmailValue(entry?.email) !== email)
  };
  replaceState(nextState);
  return res.json({ ok: true, removedEmail: email });
}

export function updateAdminEmailInboxThreadStatus(req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const threadId = String(req.params.threadId || "").trim();
  const status = normalizeEmailThreadStatus(req.body?.status);
  if (!threadId) return res.status(400).json({ ok: false, error: "threadId is required." });
  if (!EMAIL_INBOX_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, error: "Invalid status." });
  }
  const existingThread = (state.adminEmailThreads || []).find((entry) => entry.id === threadId);
  if (!existingThread) return res.status(404).json({ ok: false, error: "Email thread not found." });
  const now = new Date().toISOString();
  const nextThread = {
    ...existingThread,
    status,
    unreadCount: status === "archived" ? 0 : Number(existingThread.unreadCount || 0),
    updatedAt: now
  };
  const nextState = {
    ...state,
    adminEmailThreads: [
      nextThread,
      ...(state.adminEmailThreads || []).filter((entry) => entry.id !== threadId)
    ]
  };
  replaceState(nextState);
  return res.json({ ok: true, thread: nextThread });
}

export function deleteAdminEmailInboxThread(req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const threadId = String(req.params.threadId || "").trim();
  if (!threadId) return res.status(400).json({ ok: false, error: "threadId is required." });
  const existingThread = (state.adminEmailThreads || []).find((entry) => entry.id === threadId);
  if (!existingThread) return res.status(404).json({ ok: false, error: "Email thread not found." });
  const nextState = {
    ...state,
    adminEmailThreads: (state.adminEmailThreads || []).filter((entry) => entry.id !== threadId),
    adminEmailMessages: (state.adminEmailMessages || []).filter((entry) => entry.threadId !== threadId)
  };
  replaceState(nextState);
  return res.json({ ok: true, deletedThreadId: threadId });
}

export async function replyAdminEmailInboxThread(req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const threadId = String(req.params.threadId || "").trim();
  const body = String(req.body?.body || "").trim();
  const subjectOverride = String(req.body?.subject || "").trim();
  if (!threadId || !body) {
    return res.status(400).json({ ok: false, error: "threadId and body are required." });
  }
  const thread = (state.adminEmailThreads || []).find((entry) => entry.id === threadId);
  if (!thread) return res.status(404).json({ ok: false, error: "Email thread not found." });

  const mailbox = normalizeMailboxType(req.body?.mailbox || thread.mailbox);
  const fromEmail = getMailboxAddress(mailbox);
  const toEmail = normalizeEmailValue(req.body?.toEmail || thread.participantEmail);
  const subject = subjectOverride || String(thread.lastSubject || "Re: Message").trim() || "Re: Message";
  const toName = String(req.body?.toName || thread.participantName || "").trim();
  if (!toEmail) {
    return res.status(400).json({ ok: false, error: "Thread has no recipient email." });
  }
  const suppressionEntry = findEmailSuppression(state, toEmail);
  if (suppressionEntry) {
    return res.status(409).json({ ok: false, error: `Email is suppressed: ${suppressionEntry.reason || "manual_suppression"}.` });
  }
  const sanitizedAttachments = sanitizeOutboundAttachments(req.body?.attachments);
  if (!sanitizedAttachments.ok) {
    return res.status(400).json({ ok: false, error: sanitizedAttachments.error || "Invalid attachments." });
  }
  const scannedAttachments = await applyAttachmentScanningPolicy(sanitizedAttachments.attachments, { dropContentOnMalicious: true });
  const blockedScanAttachment = scannedAttachments.attachments.find((entry) => String(entry?.blockedReason || "").trim());
  if (blockedScanAttachment) {
    return res.status(400).json({
      ok: false,
      error: `Attachment "${blockedScanAttachment.filename}" blocked: ${blockedScanAttachment.blockedReason || "policy_block"}.`
    });
  }

  const emailResult = await sendPlatformEmail({
    toEmail,
    toName,
    subject,
    text: body,
    fromEmail,
    replyToEmail: fromEmail,
    includeDoNotReplyNotice: false,
    attachments: scannedAttachments.attachments
  });
  if (!emailResult?.delivered) {
    return res.status(502).json({ ok: false, error: `Could not send reply (${emailResult?.reason || "unknown"}).` });
  }

  const now = new Date().toISOString();
  const outboundMessage = {
    id: `email_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    mailbox,
    direction: "outbound",
    fromEmail,
    fromName: "Admin Team",
    toEmail,
    toName,
    subject,
    text: body,
    html: "",
    attachments: scannedAttachments.attachments.map((attachment) => ({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      contentBase64: attachment.contentBase64,
      blockedReason: attachment.blockedReason || "",
      scanStatus: attachment.scanStatus || "not_scanned"
    })),
    externalMessageId: String(emailResult?.messageId || "").trim(),
    externalInReplyTo: "",
    delivery: {
      status: emailResult.delivered ? "sent" : "failed",
      provider: "postmark",
      mode: emailResult.mode || "",
      reason: emailResult.reason || null,
      recipients: emailResult.recipients || [toEmail]
    },
    createdAt: now
  };
  const nextThread = {
    ...thread,
    mailbox,
    participantEmail: toEmail,
    participantName: toName || thread.participantName || toEmail,
    status: "pending_customer",
    unreadCount: 0,
    lastMessageAt: now,
    lastMessageDirection: "outbound",
    lastSubject: subject,
    lastSnippet: buildThreadSnippet(body),
    updatedAt: now
  };
  const nextState = {
    ...state,
    adminEmailThreads: [
      nextThread,
      ...(state.adminEmailThreads || []).filter((entry) => entry.id !== threadId)
    ].slice(0, 2000),
    adminEmailMessages: [
      ...(state.adminEmailMessages || []),
      outboundMessage
    ].slice(-12000)
  };
  replaceState(nextState);
  return res.json({
    ok: true,
    email: {
      delivered: emailResult.delivered,
      mode: emailResult.mode,
      recipients: emailResult.recipients || [toEmail]
    },
    thread: nextThread,
    message: outboundMessage
  });
}

export async function sendAdminEmailInboxMessage(req, res) {
  const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
  const mailbox = normalizeMailboxType(req.body?.mailbox);
  const fromEmail = getMailboxAddress(mailbox);
  const toEmail = normalizeEmailValue(req.body?.toEmail);
  const toName = String(req.body?.toName || "").trim();
  const subject = String(req.body?.subject || "").trim();
  const body = String(req.body?.body || "").trim();

  if (!toEmail || !subject || !body) {
    return res.status(400).json({ ok: false, error: "toEmail, subject, and body are required." });
  }
  if (!toEmail.includes("@")) {
    return res.status(400).json({ ok: false, error: "Valid recipient email is required." });
  }
  const suppressionEntry = findEmailSuppression(state, toEmail);
  if (suppressionEntry) {
    return res.status(409).json({ ok: false, error: `Email is suppressed: ${suppressionEntry.reason || "manual_suppression"}.` });
  }
  const sanitizedAttachments = sanitizeOutboundAttachments(req.body?.attachments);
  if (!sanitizedAttachments.ok) {
    return res.status(400).json({ ok: false, error: sanitizedAttachments.error || "Invalid attachments." });
  }
  const scannedAttachments = await applyAttachmentScanningPolicy(sanitizedAttachments.attachments, { dropContentOnMalicious: true });
  const blockedScanAttachment = scannedAttachments.attachments.find((entry) => String(entry?.blockedReason || "").trim());
  if (blockedScanAttachment) {
    return res.status(400).json({
      ok: false,
      error: `Attachment "${blockedScanAttachment.filename}" blocked: ${blockedScanAttachment.blockedReason || "policy_block"}.`
    });
  }

  const emailResult = await sendPlatformEmail({
    toEmail,
    toName,
    subject,
    text: body,
    fromEmail,
    replyToEmail: fromEmail,
    includeDoNotReplyNotice: false,
    attachments: scannedAttachments.attachments
  });
  if (!emailResult?.delivered) {
    return res.status(502).json({ ok: false, error: `Could not send email (${emailResult?.reason || "unknown"}).` });
  }

  const now = new Date().toISOString();
  const existingThread = (state.adminEmailThreads || []).find((entry) => (
    normalizeMailboxType(entry?.mailbox) === mailbox
    && normalizeEmailValue(entry?.participantEmail) === toEmail
    && normalizeEmailThreadStatus(entry?.status) !== "archived"
  )) || null;
  const threadId = existingThread?.id || `email_thread_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const outboundMessage = {
    id: `email_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    mailbox,
    direction: "outbound",
    fromEmail,
    fromName: "Admin Team",
    toEmail,
    toName,
    subject,
    text: body,
    html: "",
    attachments: scannedAttachments.attachments.map((attachment) => ({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      contentBase64: attachment.contentBase64,
      blockedReason: attachment.blockedReason || "",
      scanStatus: attachment.scanStatus || "not_scanned"
    })),
    externalMessageId: String(emailResult?.messageId || "").trim(),
    externalInReplyTo: "",
    delivery: {
      status: emailResult.delivered ? "sent" : "failed",
      provider: "postmark",
      mode: emailResult.mode || "",
      reason: emailResult.reason || null,
      recipients: emailResult.recipients || [toEmail]
    },
    createdAt: now
  };
  const nextThread = {
    ...(existingThread || {
      id: threadId,
      mailbox,
      participantEmail: toEmail,
      participantName: toName || toEmail,
      status: "pending_customer",
      unreadCount: 0,
      createdAt: now
    }),
    mailbox,
    participantEmail: toEmail,
    participantName: toName || existingThread?.participantName || toEmail,
    status: "pending_customer",
    unreadCount: 0,
    lastMessageAt: now,
    lastMessageDirection: "outbound",
    lastSubject: subject,
    lastSnippet: buildThreadSnippet(body),
    updatedAt: now
  };
  const nextState = {
    ...state,
    adminEmailThreads: [
      nextThread,
      ...(state.adminEmailThreads || []).filter((entry) => entry.id !== threadId)
    ].slice(0, 2000),
    adminEmailMessages: [
      ...(state.adminEmailMessages || []),
      outboundMessage
    ].slice(-12000)
  };
  replaceState(nextState);
  return res.json({
    ok: true,
    email: {
      delivered: emailResult.delivered,
      mode: emailResult.mode,
      recipients: emailResult.recipients || [toEmail]
    },
    thread: nextThread,
    message: outboundMessage
  });
}

export function getProducts(_req, res) {
  res.json({ products: getState().products || [] });
}

export function getSellers(_req, res) {
  res.json({ sellers: getState().sellers || [] });
}

export function getSellerPosts(_req, res) {
  const posts = [...getSellerPostsState()].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({ posts });
}

export function getPostReports(_req, res) {
  const reports = [...getPostReportsState()].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({ reports });
}

export async function deleteProduct(req, res, next) {
  try {
    const productId = req.params.productId;
    const currentUser = req.auth?.user || null;
    const sellerId = currentUser?.role === "seller" ? currentUser.sellerId : null;
    const productTitle = req.body?.productTitle;
    if (!productId && !productTitle) {
      return res.status(400).json({ error: "productId or productTitle is required." });
    }

    const result = await deleteProductFromStateAndSeed({ productId, productTitle, sellerId });
    if (!result.ok) {
      if (result.reason === "not_found") {
        return res.status(404).json({ error: "Product not found." });
      }
      if (result.reason === "forbidden") {
        return res.status(403).json({ error: "You can only delete your own products." });
      }
      return res.status(400).json({ error: "Invalid delete request." });
    }

    return res.json({
      ok: true,
      deletedProductId: result.deletedProductId,
      deletedProductTitle: result.product?.title || null,
      counts: {
        products: result.state.products?.length || 0
      }
    });
  } catch (error) {
    return next(error);
  }
}

export async function createSellerPost(req, res, next) {
  try {
    const sellerId = req.auth?.user?.sellerId;
    const image = req.body?.image;
    const imageName = req.body?.imageName || "";
    const caption = String(req.body?.caption || "").trim().slice(0, 500);
    const captionI18n = req.body?.captionI18n && typeof req.body.captionI18n === "object" ? req.body.captionI18n : {};
    const visibility = req.body?.visibility === "private" ? "private" : "public";
    const parsedAccessPrice = Number(req.body?.accessPriceUsd);
    const accessPriceUsd = Number.isFinite(parsedAccessPrice) && parsedAccessPrice >= 1
      ? Number(parsedAccessPrice.toFixed(2))
      : 1;

    const rawScheduledFor = String(req.body?.scheduledFor || "").trim();
    const scheduledForMs = rawScheduledFor ? new Date(rawScheduledFor).getTime() : NaN;
    const scheduledFor = Number.isFinite(scheduledForMs) && scheduledForMs > Date.now()
      ? new Date(scheduledForMs).toISOString()
      : "";

    if (!sellerId || !image) {
      return res.status(400).json({ error: "sellerId and image are required." });
    }

    const sellerExists = (getState().sellers || []).some((seller) => seller.id === sellerId);
    if (!sellerExists) {
      return res.status(404).json({ error: "Seller not found." });
    }

    const now = new Date().toISOString();
    const post = {
      id: `post_${Date.now()}`,
      sellerId,
      caption,
      captionI18n,
      visibility,
      accessPriceUsd,
      image,
      imageName,
      scheduledFor,
      createdAt: scheduledFor || now,
    };

    const result = await createSellerPostInStateAndSeed(post);
    if (!result.ok) {
      return res.status(400).json({ error: "Invalid post payload." });
    }

    return res.status(201).json({ ok: true, post: result.post });
  } catch (error) {
    return next(error);
  }
}

export async function deleteSellerPost(req, res, next) {
  try {
    const postId = req.params.postId;
    const currentUser = req.auth?.user || null;
    const sellerId = currentUser?.role === "seller" ? currentUser.sellerId : null;
    const isAdmin = currentUser?.role === "admin";
    if (!postId) {
      return res.status(400).json({ error: "postId is required." });
    }

    const result = await deleteSellerPostFromStateAndSeed({ postId, sellerId, isAdmin });
    if (!result.ok) {
      if (result.reason === "not_found") {
        return res.status(404).json({ error: "Post not found." });
      }
      if (result.reason === "forbidden") {
        return res.status(403).json({ error: "You can only delete your own posts." });
      }
      return res.status(400).json({ error: "Invalid delete request." });
    }

    return res.json({ ok: true, deletedPostId: result.deletedPostId });
  } catch (error) {
    return next(error);
  }
}

export async function reportSellerPost(req, res, next) {
  try {
    const postId = req.params.postId;
    const reporterUserId = req.auth?.user?.id;
    const reporterRole = req.auth?.user?.role || "buyer";
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    if (!postId || !reporterUserId || !reason) {
      return res.status(400).json({ error: "postId, reporterUserId, and reason are required." });
    }

    const post = (getSellerPostsState() || []).find((item) => item.id === postId);
    if (!post) {
      return res.status(404).json({ error: "Post not found." });
    }

    const existingOpenReport = (getPostReportsState() || []).find((report) => (
      report.postId === postId &&
      report.reporterUserId === reporterUserId &&
      report.status !== "resolved"
    ));
    if (existingOpenReport) {
      return res.status(409).json({ error: "You already reported this post." });
    }

    const report = {
      id: `post_report_${Date.now()}`,
      postId,
      sellerId: post.sellerId,
      reporterUserId,
      reporterRole,
      reason,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedByUserId: null
    };

    const result = await createPostReportInStateAndSeed(report);
    if (!result.ok) {
      return res.status(400).json({ error: "Invalid report payload." });
    }

    return res.status(201).json({ ok: true, report: result.report });
  } catch (error) {
    return next(error);
  }
}

export async function resolvePostReport(req, res, next) {
  try {
    const reportId = req.params.reportId;
    const resolvedByUserId = req.auth?.user?.id || null;
    if (!reportId) {
      return res.status(400).json({ error: "reportId is required." });
    }

    const result = await resolvePostReportInStateAndSeed({ reportId, resolvedByUserId });
    if (!result.ok) {
      if (result.reason === "not_found") {
        return res.status(404).json({ error: "Report not found." });
      }
      return res.status(400).json({ error: "Invalid resolve request." });
    }

    return res.json({ ok: true, reportId: result.reportId });
  } catch (error) {
    return next(error);
  }
}

export async function notifySellerApprovalRequest(req, res, next) {
  try {
    const sellerName = req.body?.sellerName?.trim();
    const sellerEmail = req.body?.sellerEmail?.trim();
    const requestedAt = req.body?.requestedAt || new Date().toISOString();

    if (!sellerName || !sellerEmail) {
      return res.status(400).json({ error: "sellerName and sellerEmail are required." });
    }

    const result = await sendSellerApprovalRequestEmail({
      sellerName,
      sellerEmail,
      requestedAt
    });
    const adminUserId = req.auth?.user?.id || null;
    if (adminUserId) {
      await dispatchPushNotification({
        userId: adminUserId,
        preferenceType: "adminOps",
        route: "/admin",
        titleByLang: {
          en: "Seller approval requested",
          th: "มีคำขออนุมัติผู้ขายใหม่",
          my: "Seller approval request အသစ်",
          ru: "Новый запрос на одобрение продавца"
        },
        bodyByLang: {
          en: `${sellerName} requested seller approval.`,
          th: `${sellerName} ส่งคำขออนุมัติผู้ขายแล้ว`,
          my: `${sellerName} သည် seller approval တောင်းဆိုခဲ့သည်။`,
          ru: `${sellerName} запросил(а) одобрение продавца.`
        },
        data: {
          kind: "seller_approval_request",
          sellerEmail
        }
      }).catch(() => {});
    }

    return res.json({
      ok: true,
      email: {
        delivered: result.delivered,
        mock: result.mock
      }
    });
  } catch (error) {
    return next(error);
  }
}

export async function notifyPlatformEmail(req, res, next) {
  try {
    const toEmail = String(req.body?.toEmail || "").trim().toLowerCase();
    const toName = String(req.body?.toName || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const text = String(req.body?.text || req.body?.body || "").trim();
    const templateKey = String(req.body?.templateKey || "").trim();
    const actionUrl = String(req.body?.actionUrl || "").trim();

    if (!toEmail || !subject || !text) {
      const missing = [];
      if (!toEmail) missing.push("toEmail");
      if (!subject) missing.push("subject");
      if (!text) missing.push("text/body");
      return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
    }

    const fromEmail = String(req.body?.fromEmail || "").trim().toLowerCase();
    const replyToEmail = String(req.body?.replyToEmail || "").trim().toLowerCase();
    const allowedFromEmails = new Set([
      String(env.smtpFrom || "").trim().toLowerCase(),
      String(env.supportInboxEmail || "").trim().toLowerCase(),
      String(env.adminInboxEmail || "").trim().toLowerCase()
    ].filter(Boolean));
    if (fromEmail && !allowedFromEmails.has(fromEmail)) {
      return res.status(400).json({ error: "fromEmail is not an allowed sender." });
    }
    if (replyToEmail && !allowedFromEmails.has(replyToEmail)) {
      return res.status(400).json({ error: "replyToEmail is not an allowed sender." });
    }
    const state = ensureEmailInboxCollections(ensureAdminCollections(getState()));
    const suppressionEntry = findEmailSuppression(state, toEmail);
    if (suppressionEntry) {
      return res.status(409).json({ error: `Email is suppressed: ${suppressionEntry.reason || "manual_suppression"}.` });
    }
    const sanitizedAttachments = sanitizeOutboundAttachments(req.body?.attachments);
    if (!sanitizedAttachments.ok) {
      return res.status(400).json({ error: sanitizedAttachments.error || "Invalid attachments." });
    }
    const scannedAttachments = await applyAttachmentScanningPolicy(sanitizedAttachments.attachments, { dropContentOnMalicious: true });
    const blockedScanAttachment = scannedAttachments.attachments.find((entry) => String(entry?.blockedReason || "").trim());
    if (blockedScanAttachment) {
      return res.status(400).json({
        error: `Attachment "${blockedScanAttachment.filename}" blocked: ${blockedScanAttachment.blockedReason || "policy_block"}.`
      });
    }

    const result = await sendPlatformEmail({
      toEmail,
      toName,
      subject,
      text,
      fromEmail: fromEmail || undefined,
      replyToEmail: replyToEmail || undefined,
      attachments: scannedAttachments.attachments
    });
    const adminUserId = req.auth?.user?.id || null;
    if (adminUserId) {
      await dispatchPushNotification({
        userId: adminUserId,
        preferenceType: "adminOps",
        route: "/admin",
        titleByLang: {
          en: "Platform email sent",
          th: "ส่งอีเมลแพลตฟอร์มแล้ว",
          my: "Platform email ပို့ပြီးပါပြီ",
          ru: "Платформенное письмо отправлено"
        },
        bodyByLang: {
          en: `Email sent to ${toEmail || "recipient"}: ${subject}`,
          th: `ส่งอีเมลไปยัง ${toEmail || "ผู้รับ"}: ${subject}`,
          my: `${toEmail || "လက်ခံသူ"} သို့ email ပို့ပြီးပါပြီ: ${subject}`,
          ru: `Письмо отправлено на ${toEmail || "адрес"}: ${subject}`
        },
        data: {
          kind: "platform_email_sent",
          toEmail,
          subject
        }
      }).catch(() => {});
    }

    return res.json({
      ok: true,
      email: {
        delivered: result.delivered,
        mock: result.mock,
        mode: result.mode,
        recipients: result.recipients,
        reason: result.reason || null,
        messageId: result.messageId || null
      },
      metadata: {
        templateKey,
        actionUrl
      }
    });
  } catch (error) {
    return next(error);
  }
}

export async function dispatchManagedNotification(req, res, next) {
  try {
    const recipientUserIds = Array.isArray(req.body?.recipientUserIds)
      ? req.body.recipientUserIds.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    const preferenceTypeRaw = String(req.body?.preferenceType || "engagement").trim().toLowerCase();
    const preferenceType = ["message", "engagement", "adminops", "admin_ops"].includes(preferenceTypeRaw)
      ? (preferenceTypeRaw.startsWith("admin") ? "adminOps" : preferenceTypeRaw)
      : "engagement";
    const route = String(req.body?.route || "/account").trim() || "/account";
    const titleByLang = req.body?.titleByLang && typeof req.body.titleByLang === "object" ? req.body.titleByLang : {};
    const bodyByLang = req.body?.bodyByLang && typeof req.body.bodyByLang === "object" ? req.body.bodyByLang : {};
    const sendEmail = req.body?.sendEmail === true;
    const emailSubject = String(req.body?.emailSubject || "").trim();
    const emailText = String(req.body?.emailText || "").trim();
    if (recipientUserIds.length === 0) {
      return res.status(400).json({ ok: false, error: "recipientUserIds is required." });
    }
    if (sendEmail && (!emailSubject || !emailText)) {
      return res.status(400).json({ ok: false, error: "emailSubject and emailText are required when sendEmail is enabled." });
    }

    const uniqueRecipientUserIds = [...new Set(recipientUserIds)];
    let pushRequested = 0;
    let pushSent = 0;
    let emailRequested = 0;
    let emailSent = 0;
    for (const userId of uniqueRecipientUserIds) {
      pushRequested += 1;
      const pushResult = await dispatchPushNotification({
        userId,
        preferenceType,
        route,
        titleByLang,
        bodyByLang,
        data: {
          kind: String(req.body?.kind || "managed_notification").trim() || "managed_notification",
          route
        }
      }).catch(() => ({ ok: false, sentCount: 0 }));
      pushSent += Number(pushResult?.sentCount || 0);

      if (!sendEmail) continue;
      const user = await getUserById(userId).catch(() => null);
      const toEmail = String(user?.email || "").trim().toLowerCase();
      if (!toEmail || !toEmail.includes("@")) continue;
      emailRequested += 1;
      const emailResult = await sendPlatformEmail({
        toEmail,
        toName: String(user?.name || "").trim(),
        subject: emailSubject,
        text: emailText
      }).catch(() => ({ delivered: false }));
      if (emailResult?.delivered) emailSent += 1;
    }

    return res.json({
      ok: true,
      result: {
        recipients: uniqueRecipientUserIds.length,
        pushRequested,
        pushSent,
        emailRequested,
        emailSent
      }
    });
  } catch (error) {
    return next(error);
  }
}

export async function translateText(req, res, next) {
  try {
    const text = String(req.body?.text || "").trim();
    const targetLang = String(req.body?.targetLang || "").trim().toLowerCase();
    if (!text || !targetLang) {
      return res.status(400).json({ error: "text and targetLang are required." });
    }
    if (!SUPPORTED_TRANSLATION_LANGUAGES.has(targetLang)) {
      return res.status(400).json({ error: "Unsupported target language." });
    }

    const endpoint = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(endpoint);
    if (!response.ok) {
      return res.status(502).json({ error: "Translation service unavailable." });
    }
    const payload = await response.json().catch(() => null);
    const translatedText = Array.isArray(payload?.[0])
      ? payload[0].map((chunk) => String(chunk?.[0] || "")).join("").trim()
      : "";
    if (!translatedText) {
      return res.status(502).json({ error: "Could not translate text." });
    }

    return res.json({ ok: true, translatedText });
  } catch (error) {
    return next(error);
  }
}

export async function walletReconciliation(req, res, next) {
  try {
    const summary = await getWalletReconciliationSummary();
    return res.json({ ok: true, summary });
  } catch (error) {
    return next(error);
  }
}

export async function acceptCustomRequestQuoteByBuyer(req, res, next) {
  try {
    const requestId = String(req.params.requestId || "").trim();
    const buyerUserId = req.auth?.user?.id || null;
    if (!requestId || !buyerUserId) {
      return res.status(400).json({ error: "requestId and authenticated buyer are required." });
    }
    const result = await acceptCustomRequestQuote({ requestId, buyerUserId });
    if (!result.ok) {
      return res.status(result.code || 400).json({
        ok: false,
        error: result.error || "Could not accept custom request quote.",
        shortfall: result.shortfall ?? undefined,
        requiredTopUp: result.requiredTopUp ?? undefined
      });
    }
    return res.json({
      ok: true,
      alreadyProcessed: Boolean(result.alreadyProcessed),
      requestId: result.requestId,
      quotedPrice: result.quotedPrice,
      payout: result.payout || null
    });
  } catch (error) {
    return next(error);
  }
}

export async function walletTopUp(req, res, next) {
  try {
    const userId = req.auth?.user?.id || null;
    const amountThb = Number(req.body?.amountThb || 0);
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Authentication required." });
    }
    const result = await topUpWallet({ userId, amountThb });
    if (!result.ok) {
      return res.status(result.code || 400).json({ ok: false, error: result.error });
    }
    return res.json({
      ok: true,
      userId: result.userId,
      amount: result.amount,
      walletBalance: result.walletBalance,
      db: result.db
    });
  } catch (error) {
    return next(error);
  }
}

export async function checkoutWalletPay(req, res, next) {
  try {
    const buyerUserId = req.auth?.user?.id || null;
    if (!buyerUserId) {
      return res.status(401).json({ ok: false, error: "Authentication required." });
    }
    const result = await payCheckoutWithWallet({
      buyerUserId,
      itemIds: req.body?.itemIds,
      buyerEmail: req.body?.buyerEmail,
      shippingAddress: req.body?.shippingAddress,
      shippingCountry: req.body?.shippingCountry,
      shippingPostalCode: req.body?.shippingPostalCode,
      shippingMethod: req.body?.shippingMethod,
      shippingFee: req.body?.shippingFee,
      saveAddressToProfile: req.body?.saveAddressToProfile
    });
    if (!result.ok) {
      return res.status(result.code || 400).json({
        ok: false,
        error: result.error,
        shortfall: result.shortfall ?? undefined,
        requiredTopUp: result.requiredTopUp ?? undefined
      });
    }
    return res.json({
      ok: true,
      orderId: result.orderId,
      total: result.total,
      subtotal: result.subtotal,
      shippingFee: result.shippingFee,
      walletBalance: result.walletBalance,
      db: result.db
    });
  } catch (error) {
    return next(error);
  }
}

export async function sendBuyerMessageWithFee(req, res, next) {
  try {
    const buyerUserId = req.auth?.user?.id || null;
    const result = await sendBuyerPaidMessage({
      buyerUserId,
      sellerId: req.body?.sellerId,
      conversationId: req.body?.conversationId,
      body: req.body?.body
    });
    if (!result.ok) {
      return res.status(result.code || 400).json({
        ok: false,
        error: result.error,
        shortfall: result.shortfall ?? undefined,
        requiredTopUp: result.requiredTopUp ?? undefined
      });
    }
    return res.json({
      ok: true,
      walletBalance: result.walletBalance,
      db: result.db
    });
  } catch (error) {
    return next(error);
  }
}

export async function createCustomRequestByBuyer(req, res, next) {
  try {
    const buyerUserId = req.auth?.user?.id || null;
    const result = await createBuyerCustomRequest({
      buyerUserId,
      sellerId: req.body?.sellerId,
      buyerName: req.body?.buyerName,
      buyerEmail: req.body?.buyerEmail,
      preferredDetails: req.body?.preferredDetails,
      shippingCountry: req.body?.shippingCountry,
      requestBody: req.body?.requestBody
    });
    if (!result.ok) {
      return res.status(result.code || 400).json({
        ok: false,
        error: result.error,
        shortfall: result.shortfall ?? undefined,
        requiredTopUp: result.requiredTopUp ?? undefined
      });
    }
    return res.status(201).json({
      ok: true,
      requestId: result.requestId,
      walletBalance: result.walletBalance,
      db: result.db
    });
  } catch (error) {
    return next(error);
  }
}


export async function updateBarProfile(req, res) {
  const barId = String(req.params?.barId || "").trim();
  if (!barId) return res.status(400).json({ error: "Bar ID is required." });
  const user = req.auth?.user;
  const isAdmin = user?.role === "admin" || user?.isSuperAdmin === true || user?.hasAdminAccess === true;
  if (!user || (user.role !== "bar" && !isAdmin)) return res.status(403).json({ error: "Only bar or admin accounts can update bar profiles." });
  if (!isAdmin && String(user.barId || "").trim() !== barId) return res.status(403).json({ error: "You can only update your own bar profile." });

  const { name, location, about, specials, mapEmbedUrl, mapLink, profileImage, profileImageName, aboutI18n, specialsI18n } = req.body || {};
  const state = getState();
  const existingBars = Array.isArray(state.bars) ? state.bars : [];
  const barIndex = existingBars.findIndex((b) => String(b?.id || "").trim() === barId);

  const barRecord = {
    id: barId,
    name: String(name || user.name || "").trim(),
    location: String(location || "").trim(),
    about: String(about || "").trim(),
    specials: String(specials || "").trim(),
    mapEmbedUrl: String(mapEmbedUrl || "").trim(),
    mapLink: String(mapLink || "").trim(),
    profileImage: String(profileImage || "").slice(0, 2 * 1024 * 1024),
    profileImageName: String(profileImageName || "").trim(),
    aboutI18n: aboutI18n && typeof aboutI18n === "object" ? aboutI18n : {},
    specialsI18n: specialsI18n && typeof specialsI18n === "object" ? specialsI18n : {},
  };

  let nextBars;
  if (barIndex >= 0) {
    nextBars = existingBars.map((b, i) => (i === barIndex ? { ...b, ...barRecord } : b));
  } else {
    nextBars = [...existingBars, barRecord];
  }

  await replaceStateAndSeed({ ...state, bars: nextBars });
  return res.json({ ok: true, bar: barRecord });
}


function buildSlug(value, fallback) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback || "item";
}

export async function approveSellerByAdmin(req, res) {
  const userId = String(req.params?.userId || "").trim();
  if (!userId) return res.status(400).json({ error: "User ID is required." });

  const state = getState();
  const users = Array.isArray(state.users) ? state.users : [];
  const targetUser = users.find((u) => u.id === userId);
  if (!targetUser) return res.status(404).json({ error: "User not found." });
  if (targetUser.role !== "seller") return res.status(400).json({ error: "User is not a seller." });
  if (targetUser.accountStatus === "active" && targetUser.sellerId) {
    return res.json({ ok: true, sellerId: targetUser.sellerId, alreadyApproved: true });
  }

  const slugBase = targetUser.requestedSellerSlug || buildSlug(targetUser.name, "new-seller");
  let sellerId = targetUser.sellerId || slugBase;
  const existingSellers = Array.isArray(state.sellers) ? state.sellers : [];
  if (!targetUser.sellerId) {
    let count = 1;
    while (existingSellers.some((s) => s.id === sellerId)) {
      count += 1;
      sellerId = `${slugBase}-${count}`;
    }
  }

  const now = new Date().toISOString();
  const sellerAlreadyExists = existingSellers.some((s) => s.id === sellerId);
  const nextSellers = sellerAlreadyExists
    ? existingSellers
    : [
        ...existingSellers,
        {
          id: sellerId,
          name: `${targetUser.name} Studio`,
          location: [targetUser.city, targetUser.country].filter(Boolean).join(", ") || "",
          specialty: "Everyday",
          specialties: ["Everyday"],
          bio: "",
          shipping: "Worldwide",
          turnaround: "Ships in 1-3 days",
          isOnline: false,
          feedVisibility: "public",
          languages: ["English"],
          highlights: ["New seller"],
          portfolioUrl: "",
          height: targetUser.heightCm || targetUser.height || "",
          weight: targetUser.weightKg || targetUser.weight || "",
          hairColor: targetUser.hairColor || "",
          braSize: targetUser.braSize || "",
          pantySize: targetUser.pantySize || "",
        },
      ];

  const nextUsers = users.map((u) =>
    u.id === userId
      ? { ...u, accountStatus: "active", sellerId, approvedAt: now, sellerApplicationStatus: "approved" }
      : u
  );

  await replaceStateAndSeed({ ...state, users: nextUsers, sellers: nextSellers });

  if (hasPostgresConfig()) {
    try {
      await pgQuery(
        `UPDATE app_users SET seller_id = $1, account_status = 'active', updated_at = NOW() WHERE id = $2`,
        [sellerId, userId]
      );
    } catch (_pgErr) { /* JSON state is source of truth; Postgres is best-effort */ }
  }

  return res.json({ ok: true, sellerId });
}

export async function updateSellerProfile(req, res) {
  const sellerId = String(req.params?.sellerId || "").trim();
  if (!sellerId) return res.status(400).json({ error: "Seller ID is required." });
  const user = req.auth?.user;
  const isAdmin = user?.role === "admin" || user?.isSuperAdmin === true || user?.hasAdminAccess === true;
  if (!user || (user.role !== "seller" && !isAdmin)) {
    return res.status(403).json({ error: "Only seller or admin accounts can update seller profiles." });
  }
  if (!isAdmin && String(user.sellerId || "").trim() !== sellerId) {
    return res.status(403).json({ error: "You can only update your own seller profile." });
  }

  const body = req.body || {};
  const state = getState();
  const existingSellers = Array.isArray(state.sellers) ? state.sellers : [];
  const sellerIndex = existingSellers.findIndex((s) => String(s?.id || "").trim() === sellerId);

  const profileImage = String(body.profileImage || "").slice(0, 2 * 1024 * 1024);
  const specialties = Array.isArray(body.specialties) ? body.specialties.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 8) : undefined;
  const languages = Array.isArray(body.languages) ? body.languages.map((v) => String(v || "").trim()).filter(Boolean) : undefined;

  const patch = {
    ...(body.location !== undefined ? { location: String(body.location || "").trim() } : {}),
    ...(body.locationI18n && typeof body.locationI18n === "object" ? { locationI18n: body.locationI18n } : {}),
    ...(specialties ? { specialties, specialty: specialties.join(" · ") || "" } : {}),
    ...(body.specialtyI18n && typeof body.specialtyI18n === "object" ? { specialtyI18n: body.specialtyI18n } : {}),
    ...(body.bio !== undefined ? { bio: String(body.bio || "").trim() } : {}),
    ...(body.bioI18n && typeof body.bioI18n === "object" ? { bioI18n: body.bioI18n } : {}),
    ...(body.shipping !== undefined ? { shipping: String(body.shipping || "").trim() } : {}),
    ...(body.shippingI18n && typeof body.shippingI18n === "object" ? { shippingI18n: body.shippingI18n } : {}),
    ...(body.turnaround !== undefined ? { turnaround: String(body.turnaround || "").trim() } : {}),
    ...(body.turnaroundI18n && typeof body.turnaroundI18n === "object" ? { turnaroundI18n: body.turnaroundI18n } : {}),
    ...(languages ? { languages } : {}),
    ...(profileImage ? { profileImage } : {}),
    ...(body.profileImageName !== undefined ? { profileImageName: String(body.profileImageName || "").trim() } : {}),
    ...(body.height !== undefined ? { height: body.height } : {}),
    ...(body.weight !== undefined ? { weight: body.weight } : {}),
    ...(body.hairColor !== undefined ? { hairColor: String(body.hairColor || "").trim() } : {}),
    ...(body.braSize !== undefined ? { braSize: String(body.braSize || "").trim() } : {}),
    ...(body.pantySize !== undefined ? { pantySize: String(body.pantySize || "").trim() } : {}),
    ...(body.affiliatedBarId !== undefined ? { affiliatedBarId: String(body.affiliatedBarId || "").trim() } : {}),
    ...(body.feedVisibility !== undefined ? { feedVisibility: String(body.feedVisibility || "public").trim() } : {}),
  };

  let nextSellers;
  if (sellerIndex >= 0) {
    nextSellers = existingSellers.map((s, i) => (i === sellerIndex ? { ...s, ...patch } : s));
  } else {
    nextSellers = [...existingSellers, { id: sellerId, name: user.name || "", ...patch }];
  }

  await replaceStateAndSeed({ ...state, sellers: nextSellers });
  return res.json({ ok: true, seller: nextSellers.find((s) => s.id === sellerId) });
}

export async function createProduct(req, res) {
  const user = req.auth?.user;
  if (!user || user.role !== "seller") return res.status(403).json({ error: "Only sellers can create products." });
  const sellerId = String(user.sellerId || "").trim();
  if (!sellerId) return res.status(400).json({ error: "Seller profile not set up yet." });

  const body = req.body || {};
  const title = String(body.title || "").trim();
  if (!title) return res.status(400).json({ error: "Product title is required." });
  const priceTHB = Number(body.priceTHB);
  if (!Number.isFinite(priceTHB) || priceTHB <= 0) return res.status(400).json({ error: "Valid price is required." });

  const productId = body.id || `product_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const image = String(body.image || "").slice(0, 2 * 1024 * 1024);

  const product = {
    id: productId,
    sellerId,
    title,
    description: String(body.description || "").trim(),
    priceTHB: Number(priceTHB.toFixed(2)),
    image,
    imageName: String(body.imageName || "").trim(),
    category: String(body.category || "panties").trim(),
    status: String(body.status || "Draft").trim(),
    wearDays: body.wearDays || null,
    extras: Array.isArray(body.extras) ? body.extras : [],
    createdAt: new Date().toISOString(),
  };

  const state = getState();
  const nextProducts = [product, ...(Array.isArray(state.products) ? state.products : [])];
  await replaceStateAndSeed({ ...state, products: nextProducts });
  return res.status(201).json({ ok: true, product });
}

export async function createAffiliationRequest(req, res) {
  const user = req.auth?.user;
  if (!user) return res.status(401).json({ error: "Authentication required." });

  const body = req.body || {};
  const sellerId = String(body.sellerId || "").trim();
  const barId = String(body.barId || "").trim();
  const direction = String(body.direction || "seller_to_bar").trim();
  if (!sellerId || !barId) return res.status(400).json({ error: "sellerId and barId are required." });

  const requestId = body.id || `bar_affiliation_request_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();

  const request = {
    id: requestId,
    direction,
    sellerId,
    barId,
    targetBarUserIds: Array.isArray(body.targetBarUserIds) ? body.targetBarUserIds : [],
    requestedByUserId: user.id,
    requestedByRole: user.role,
    status: "pending",
    sellerMessage: String(body.sellerMessage || "").trim(),
    sellerImages: Array.isArray(body.sellerImages) ? body.sellerImages.map((img) => String(img || "").slice(0, 2 * 1024 * 1024)) : [],
    createdAt: now,
    respondedAt: null,
    respondedByUserId: null,
  };

  const state = getState();
  const nextRequests = [request, ...(Array.isArray(state.barAffiliationRequests) ? state.barAffiliationRequests : [])];
  await replaceStateAndSeed({ ...state, barAffiliationRequests: nextRequests });
  return res.status(201).json({ ok: true, request });
}

export async function respondToAffiliationRequest(req, res) {
  const user = req.auth?.user;
  if (!user) return res.status(401).json({ error: "Authentication required." });

  const requestId = String(req.params?.requestId || "").trim();
  if (!requestId) return res.status(400).json({ error: "Request ID is required." });

  const decision = String(req.body?.decision || "").trim();
  if (!["approved", "rejected", "cancelled"].includes(decision)) {
    return res.status(400).json({ error: "decision must be approved, rejected, or cancelled." });
  }

  const state = getState();
  const requests = Array.isArray(state.barAffiliationRequests) ? state.barAffiliationRequests : [];
  const existing = requests.find((r) => r.id === requestId);
  if (!existing) return res.status(404).json({ error: "Affiliation request not found." });

  const now = new Date().toISOString();
  let nextSellers = Array.isArray(state.sellers) ? [...state.sellers] : [];

  if (decision === "approved") {
    nextSellers = nextSellers.map((s) =>
      s.id === existing.sellerId ? { ...s, affiliatedBarId: existing.barId } : s
    );
  }

  const nextRequests = requests.map((r) =>
    r.id === requestId
      ? { ...r, status: decision, respondedAt: now, respondedByUserId: user.id }
      : r
  );

  await replaceStateAndSeed({ ...state, barAffiliationRequests: nextRequests, sellers: nextSellers });
  return res.json({ ok: true, requestId, decision });
}

export async function sendBarMessage(req, res) {
  const user = req.auth?.user;
  if (!user) return res.status(401).json({ error: "Authentication required." });

  const body = req.body || {};
  const conversationId = String(body.conversationId || "").trim();
  const messageBody = String(body.body || "").trim();
  const barId = String(body.barId || "").trim();
  if (!conversationId || !messageBody || !barId) {
    return res.status(400).json({ error: "conversationId, body, and barId are required." });
  }

  const now = new Date().toISOString();
  const message = {
    id: `bar_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    conversationId,
    barId,
    participantRole: String(body.participantRole || "").trim(),
    participantUserId: String(body.participantUserId || "").trim(),
    senderId: user.id,
    senderRole: user.role,
    body: messageBody,
    bodyOriginal: messageBody,
    sourceLanguage: String(body.sourceLanguage || "en").trim(),
    translations: body.translations && typeof body.translations === "object" ? body.translations : {},
    feeCharged: 0,
    createdAt: now,
    readByBar: user.role === "bar",
    readByParticipant: user.role !== "bar",
  };

  const state = getState();
  const nextMessages = [...(Array.isArray(state.messages) ? state.messages : []), message];
  await replaceStateAndSeed({ ...state, messages: nextMessages });
  return res.status(201).json({ ok: true, message });
}

export async function toggleSellerFollowHandler(req, res) {
  const user = req.auth?.user;
  if (!user) return res.status(401).json({ error: "Authentication required." });
  const sellerId = String(req.body?.sellerId || "").trim();
  if (!sellerId) return res.status(400).json({ error: "sellerId is required." });

  const state = getState();
  const follows = Array.isArray(state.sellerFollows) ? state.sellerFollows : [];
  const existing = follows.find((e) => e.sellerId === sellerId && e.followerUserId === user.id);

  let nextFollows;
  let following;
  if (existing) {
    nextFollows = follows.filter((e) => !(e.sellerId === sellerId && e.followerUserId === user.id));
    following = false;
  } else {
    nextFollows = [
      { id: `seller_follow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, sellerId, followerUserId: user.id, followerRole: user.role, createdAt: new Date().toISOString() },
      ...follows,
    ];
    following = true;
  }

  await replaceStateAndSeed({ ...state, sellerFollows: nextFollows });
  return res.json({ ok: true, following });
}

export async function toggleBarFollowHandler(req, res) {
  const user = req.auth?.user;
  if (!user) return res.status(401).json({ error: "Authentication required." });
  const barId = String(req.body?.barId || "").trim();
  if (!barId) return res.status(400).json({ error: "barId is required." });

  const state = getState();
  const follows = Array.isArray(state.barFollows) ? state.barFollows : [];
  const existing = follows.find((e) => e.barId === barId && e.followerUserId === user.id);

  let nextFollows;
  let following;
  if (existing) {
    nextFollows = follows.filter((e) => !(e.barId === barId && e.followerUserId === user.id));
    following = false;
  } else {
    nextFollows = [
      { id: `bar_follow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, barId, followerUserId: user.id, followerRole: user.role, createdAt: new Date().toISOString() },
      ...follows,
    ];
    following = true;
  }

  await replaceStateAndSeed({ ...state, barFollows: nextFollows });
  return res.json({ ok: true, following });
}

