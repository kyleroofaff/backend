import {
  createPostReportInStateAndSeed,
  createSellerPostInStateAndSeed,
  deleteProductFromStateAndSeed,
  deleteSellerPostFromStateAndSeed,
  getPostReportsState,
  getSellerPostsState,
  getState,
  replaceState,
  resolvePostReportInStateAndSeed,
  resetState
} from "../db/store.js";
import { sendPlatformEmail, sendSellerApprovalRequestEmail } from "../services/mailer.js";
import { dispatchPushNotification } from "../services/pushService.js";
import { getWalletReconciliationSummary } from "../services/reconciliation.js";
import { acceptCustomRequestQuote } from "../services/customRequestPayments.js";
import { payCheckoutWithWallet, topUpWallet } from "../services/walletCommerce.js";
import { createBuyerCustomRequest, sendBuyerPaidMessage } from "../services/buyerMoneyFlows.js";
import { env } from "../config/env.js";

const SUPPORTED_TRANSLATION_LANGUAGES = new Set(["en", "th", "my", "ru"]);
const PAYOUT_SCHEDULE = "monthly";
const PAYOUT_MIN_THRESHOLD_THB = 100;
const PAYOUT_HOLD_DAYS = 14;
const DEFAULT_PROMPTPAY_RECEIVER_MOBILE = "0812345678";
const PAYOUT_ELIGIBLE_TYPES = new Set(["message_fee", "order_sale_earning", "order_bar_commission"]);

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

    if (!sellerId || !image) {
      return res.status(400).json({ error: "sellerId and image are required." });
    }

    const sellerExists = (getState().sellers || []).some((seller) => seller.id === sellerId);
    if (!sellerExists) {
      return res.status(404).json({ error: "Seller not found." });
    }

    const post = {
      id: `post_${Date.now()}`,
      sellerId,
      caption,
      captionI18n,
      visibility,
      accessPriceUsd,
      image,
      imageName,
      createdAt: new Date().toISOString()
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
    const text = String(req.body?.text || "").trim();
    const templateKey = String(req.body?.templateKey || "").trim();
    const actionUrl = String(req.body?.actionUrl || "").trim();

    if (!toEmail || !subject || !text) {
      return res.status(400).json({ error: "toEmail, subject, and text are required." });
    }

    const result = await sendPlatformEmail({
      toEmail,
      toName,
      subject,
      text
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
        reason: result.reason || null
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
