import {
  addOrderTracking,
  getOrderTracking,
  removeOrderTracking
} from "../controllers/trackingController.js";
import { Router } from "express";
import {
  login,
  me,
  register,
  resendVerificationEmail,
  updateUserAdminAccessBySuperAdmin,
  updateOwnCredentials,
  updateUserCredentialsByAdmin,
  verifyEmail,
  impersonateUser
} from "../controllers/authController.js";
import {
  pushConfig,
  subscribePush,
  unsubscribePush,
  updatePushPreferences
} from "../controllers/pushController.js";
import {
  acceptCustomRequestQuoteByBuyer,
  createCustomRequestByBuyer,
  checkoutWalletPay,
  createSellerPost,
  deleteProduct,
  deleteSellerPost,
  getBootstrap,
  getAdminEmailInboxThreadMessages,
  getAdminEmailInboxThreads,
  downloadAdminEmailInboxAttachment,
  getAdminEmailInboxHealth,
  listEmailSuppressions,
  getPostReports,
  getProducts,
  getSellerPosts,
  getSellers,
  health,
  readiness,
  notifyPlatformEmail,
  notifySellerApprovalRequest,
  translateText,
  reportSellerPost,
  resolvePostReport,
  reset,
  saveState,
  sendBuyerMessageWithFee,
  updatePromptPayReceiver,
  createMonthlyPayoutRun,
  dispatchManagedNotification,
  markPayoutItemSent,
  ingestPostmarkInboundEmail,
  markPayoutItemFailed,
  walletTopUp,
  walletReconciliation,
  deleteAdminEmailInboxThread,
  replyAdminEmailInboxThread,
  sendAdminEmailInboxMessage,
  upsertEmailSuppression,
  removeEmailSuppression,
  updateAdminEmailInboxThreadStatus,
  updateBarProfile,
  approveSellerByAdmin,
  updateSellerProfile,
  createProduct,
  createAffiliationRequest,
  respondToAffiliationRequest,
  sendBarMessage,
  toggleSellerFollowHandler,
  toggleBarFollowHandler
} from "../controllers/marketplaceController.js";
import {
  getActiveCatalog,
  getFullCatalog,
  updateCatalogItem,
  purchaseGift,
  getFulfillmentTasks,
  updateFulfillmentTaskStatus
} from "../services/giftService.js";
import {
  ADMIN_SCOPES,
  requireAdminAccess,
  requireAdminScope,
  requireAuth,
  requireNonProduction,
  requireRole,
  requireSuperAdmin
} from "../middlewares/auth.js";
import { rejectUnknownBodyKeys, strictAuthRateLimit } from "../middlewares/security.js";
import { idempotencyOptional, requireIdempotencyKey } from "../middlewares/idempotency.js";
import multer from "multer";
import { existsSync, mkdirSync } from "fs";
import { extname } from "path";

const MEDIA_DIR = "/app/data/media";
if (!existsSync(MEDIA_DIR)) {
  try { mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}
}

const mediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname || "").toLowerCase() || ".bin";
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const mediaUpload = multer({
  storage: mediaStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/") || file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image and video files are allowed"));
    }
  },
});

const router = Router();

router.get("/health", health);
router.get("/health/ready", readiness);
router.get("/push/config", pushConfig);
router.post("/auth/login", strictAuthRateLimit, rejectUnknownBodyKeys(["email", "password"]), login);
router.post(
  "/auth/register",
  strictAuthRateLimit,
  rejectUnknownBodyKeys([
    "name",
    "email",
    "password",
    "role",
    "city",
    "country",
    "preferredLanguage",
    "acceptedRespectfulConduct",
    "acceptedNoRefunds",
    "skipEmailVerification",
    "heightCm",
    "weightKg",
    "hairColor",
    "braSize",
    "pantySize"
  ]),
  register
);
router.post("/auth/verify-email", strictAuthRateLimit, rejectUnknownBodyKeys(["email", "token"]), verifyEmail);
router.post("/auth/resend-verification", strictAuthRateLimit, rejectUnknownBodyKeys(["email"]), resendVerificationEmail);
router.get("/auth/me", requireAuth, me);
router.post(
  "/auth/account-credentials",
  requireAuth,
  rejectUnknownBodyKeys(["currentPassword", "newEmail", "newPassword"]),
  updateOwnCredentials
);
router.post(
  "/admin/users/:userId/credentials",
  requireAuth,
  requireAdminScope(ADMIN_SCOPES.USERS_CREDENTIALS_MANAGE),
  idempotencyOptional,
  rejectUnknownBodyKeys(["newEmail", "newPassword"]),
  updateUserCredentialsByAdmin
);
router.post(
  "/admin/users/:userId/admin-access",
  requireAuth,
  requireSuperAdmin,
  idempotencyOptional,
  rejectUnknownBodyKeys(["enabled", "scopes"]),
  updateUserAdminAccessBySuperAdmin
);
router.post("/admin/impersonate/:userId", requireAuth, requireSuperAdmin, impersonateUser);
router.post("/push/subscribe", requireAuth, rejectUnknownBodyKeys(["subscription"]), subscribePush);
router.post("/push/unsubscribe", requireAuth, rejectUnknownBodyKeys(["endpoint"]), unsubscribePush);
router.post("/push/preferences", requireAuth, rejectUnknownBodyKeys(["push"]), updatePushPreferences);
router.get("/bootstrap", getBootstrap);
router.post("/state", requireAuth, requireSuperAdmin, requireNonProduction, idempotencyOptional, rejectUnknownBodyKeys(["db"]), saveState);
router.post("/reset", requireAuth, requireSuperAdmin, requireNonProduction, idempotencyOptional, reset);
router.get("/products", getProducts);
router.delete("/products/:productId", requireAuth, requireRole("seller", "admin"), idempotencyOptional, rejectUnknownBodyKeys(["productTitle"]), deleteProduct);
router.get("/sellers", getSellers);
router.put("/bars/:barId", requireAuth, requireRole("bar", "admin"), rejectUnknownBodyKeys(["name", "location", "about", "specials", "mapEmbedUrl", "mapLink", "profileImage", "profileImageName", "aboutI18n", "specialsI18n"]), updateBarProfile);
router.put(
  "/sellers/:sellerId",
  requireAuth,
  rejectUnknownBodyKeys([
    "profileImage", "profileImageName", "location", "locationI18n",
    "specialties", "specialtyI18n", "bio", "bioI18n",
    "shipping", "shippingI18n", "turnaround", "turnaroundI18n",
    "languages", "height", "weight", "hairColor", "braSize", "pantySize",
    "affiliatedBarId", "feedVisibility", "birthDay", "birthMonth", "disabledGiftTypes"
  ]),
  updateSellerProfile
);
router.post(
  "/products",
  requireAuth,
  requireRole("seller"),
  idempotencyOptional,
  rejectUnknownBodyKeys(["id", "title", "description", "priceTHB", "image", "imageName", "images", "category", "status", "wearDays", "extras"]),
  createProduct
);
router.get("/seller-posts", getSellerPosts);
router.post("/seller-posts", requireAuth, requireRole("seller"), idempotencyOptional, rejectUnknownBodyKeys(["image", "imageName", "caption", "captionI18n", "visibility", "accessPriceUsd", "scheduledFor", "mediaType"]), createSellerPost);
router.delete("/seller-posts/:postId", requireAuth, requireRole("seller", "admin"), idempotencyOptional, deleteSellerPost);
router.post("/seller-posts/:postId/report", requireAuth, requireRole("buyer", "seller", "admin"), idempotencyOptional, rejectUnknownBodyKeys(["reason"]), reportSellerPost);
router.get("/seller-post-reports", requireAuth, requireAdminScope(ADMIN_SCOPES.PRODUCTS_MODERATE), getPostReports);
router.post("/seller-post-reports/:reportId/resolve", requireAuth, requireAdminScope(ADMIN_SCOPES.PRODUCTS_MODERATE), idempotencyOptional, resolvePostReport);
router.post(
  "/admin/users/:userId/approve-seller",
  requireAuth,
  requireAdminScope(ADMIN_SCOPES.AUTH_REVIEW),
  idempotencyOptional,
  approveSellerByAdmin
);
router.post(
  "/affiliation-requests",
  requireAuth,
  idempotencyOptional,
  rejectUnknownBodyKeys(["id", "sellerId", "barId", "direction", "targetBarUserIds", "sellerMessage", "sellerImages"]),
  createAffiliationRequest
);
router.patch(
  "/affiliation-requests/:requestId",
  requireAuth,
  idempotencyOptional,
  rejectUnknownBodyKeys(["decision"]),
  respondToAffiliationRequest
);
router.post(
  "/messages/bar-send",
  requireAuth,
  idempotencyOptional,
  rejectUnknownBodyKeys(["conversationId", "body", "barId", "participantRole", "participantUserId", "sourceLanguage", "translations", "mediaUrl", "mediaType"]),
  sendBarMessage
);
router.post("/seller-follows/toggle", requireAuth, requireRole("buyer"), idempotencyOptional, rejectUnknownBodyKeys(["sellerId"]), toggleSellerFollowHandler);
router.post("/bar-follows/toggle", requireAuth, idempotencyOptional, rejectUnknownBodyKeys(["barId"]), toggleBarFollowHandler);
router.post("/notifications/seller-approval-request", requireAuth, requireAdminScope(ADMIN_SCOPES.AUTH_REVIEW), idempotencyOptional, rejectUnknownBodyKeys(["sellerName", "sellerEmail", "requestedAt"]), notifySellerApprovalRequest);
router.post("/notifications/platform-email", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), idempotencyOptional, rejectUnknownBodyKeys(["toEmail", "toName", "subject", "text", "body", "templateKey", "actionUrl", "fromEmail", "replyToEmail", "attachments"]), notifyPlatformEmail);
router.post("/notifications/dispatch", requireAuth, requireAdminAccess, idempotencyOptional, rejectUnknownBodyKeys(["recipientUserIds", "preferenceType", "route", "titleByLang", "bodyByLang", "sendEmail", "emailSubject", "emailText", "kind"]), dispatchManagedNotification);
router.post("/webhooks/postmark/inbound", ingestPostmarkInboundEmail);
router.post("/admin/site-settings/promptpay", requireAuth, requireAdminScope(ADMIN_SCOPES.PAYMENTS_MANAGE), idempotencyOptional, rejectUnknownBodyKeys(["promptPayReceiverMobile"]), updatePromptPayReceiver);
router.post("/admin/payout-runs/monthly", requireAuth, requireAdminScope(ADMIN_SCOPES.PAYMENTS_MANAGE), requireIdempotencyKey, idempotencyOptional, rejectUnknownBodyKeys(["monthValue", "notes"]), createMonthlyPayoutRun);
router.post("/admin/payout-items/:payoutItemId/sent", requireAuth, requireAdminScope(ADMIN_SCOPES.PAYMENTS_MANAGE), requireIdempotencyKey, idempotencyOptional, rejectUnknownBodyKeys(["method", "externalReference", "notes"]), markPayoutItemSent);
router.post("/admin/payout-items/:payoutItemId/failed", requireAuth, requireAdminScope(ADMIN_SCOPES.PAYMENTS_MANAGE), requireIdempotencyKey, idempotencyOptional, rejectUnknownBodyKeys(["reason"]), markPayoutItemFailed);
router.get("/admin/email-inbox/threads", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), getAdminEmailInboxThreads);
router.get("/admin/email-inbox/threads/:threadId/messages", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), getAdminEmailInboxThreadMessages);
router.get("/admin/email-inbox/threads/:threadId/messages/:messageId/attachments/:attachmentId", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), downloadAdminEmailInboxAttachment);
router.get("/admin/email-inbox/health", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), getAdminEmailInboxHealth);
router.get("/admin/email-inbox/suppressions", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), listEmailSuppressions);
router.post("/admin/email-inbox/suppressions", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), idempotencyOptional, rejectUnknownBodyKeys(["email", "reason"]), upsertEmailSuppression);
router.delete("/admin/email-inbox/suppressions/:email", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), idempotencyOptional, removeEmailSuppression);
router.delete("/admin/email-inbox/threads/:threadId", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), idempotencyOptional, deleteAdminEmailInboxThread);
router.post("/admin/email-inbox/send", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), requireIdempotencyKey, idempotencyOptional, rejectUnknownBodyKeys(["mailbox", "toEmail", "toName", "subject", "body", "attachments"]), sendAdminEmailInboxMessage);
router.post("/admin/email-inbox/threads/:threadId/reply", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), requireIdempotencyKey, idempotencyOptional, rejectUnknownBodyKeys(["mailbox", "toEmail", "toName", "subject", "body", "attachments"]), replyAdminEmailInboxThread);
router.post("/admin/email-inbox/threads/:threadId/status", requireAuth, requireAdminScope(ADMIN_SCOPES.EMAIL_INBOX_MANAGE), idempotencyOptional, rejectUnknownBodyKeys(["status"]), updateAdminEmailInboxThreadStatus);
router.post("/translate", requireAuth, idempotencyOptional, rejectUnknownBodyKeys(["text", "targetLang"]), translateText);
router.get("/reconciliation/wallet", requireAuth, requireAdminScope(ADMIN_SCOPES.PAYMENTS_MANAGE), walletReconciliation);
router.post(
  "/messages/buyer-send",
  requireAuth,
  requireRole("buyer"),
  requireIdempotencyKey,
  idempotencyOptional,
  rejectUnknownBodyKeys(["sellerId", "conversationId", "body", "mediaUrl", "mediaType"]),
  sendBuyerMessageWithFee
);
router.post(
  "/custom-requests",
  requireAuth,
  requireRole("buyer"),
  requireIdempotencyKey,
  idempotencyOptional,
  rejectUnknownBodyKeys(["sellerId", "buyerName", "buyerEmail", "preferredDetails", "shippingCountry", "requestBody"]),
  createCustomRequestByBuyer
);
router.post(
  "/wallet/top-up",
  requireAuth,
  requireRole("buyer", "seller", "bar"),
  requireIdempotencyKey,
  idempotencyOptional,
  rejectUnknownBodyKeys(["amountThb"]),
  walletTopUp
);
router.post(
  "/checkout/wallet-pay",
  requireAuth,
  requireRole("buyer"),
  requireIdempotencyKey,
  idempotencyOptional,
  rejectUnknownBodyKeys([
    "itemIds",
    "buyerEmail",
    "shippingAddress",
    "shippingCountry",
    "shippingPostalCode",
    "shippingMethod",
    "shippingFee",
    "saveAddressToProfile"
  ]),
  checkoutWalletPay
);
router.post(
  "/custom-requests/:requestId/accept",
  requireAuth,
  requireRole("buyer"),
  requireIdempotencyKey,
  idempotencyOptional,
  rejectUnknownBodyKeys([]),
  acceptCustomRequestQuoteByBuyer
);

router.post("/orders/:orderId/tracking", requireAuth, rejectUnknownBodyKeys(["trackingNumber", "slug"]), addOrderTracking);
router.get("/orders/:orderId/tracking", requireAuth, getOrderTracking);
router.delete("/orders/:orderId/tracking", requireAuth, requireSuperAdmin, removeOrderTracking);

router.get("/gifts/catalog", (req, res) => res.json(getActiveCatalog()));
router.get("/gifts/catalog/admin", requireAuth, requireAdminAccess, (req, res) => res.json(getFullCatalog()));
router.patch(
  "/gifts/catalog/:id",
  requireAuth,
  requireAdminAccess,
  idempotencyOptional,
  rejectUnknownBodyKeys(["isActive", "price"]),
  async (req, res) => {
    const result = await updateCatalogItem(req.params.id, { isActive: req.body.isActive, price: req.body.price });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  }
);
router.post(
  "/gifts/purchase",
  requireAuth,
  requireRole("buyer"),
  requireIdempotencyKey,
  idempotencyOptional,
  rejectUnknownBodyKeys(["sellerId", "giftType", "message", "isAnonymous", "occasionType"]),
  async (req, res) => {
    const result = await purchaseGift({
      buyerUserId: req.auth.user.id,
      sellerId: req.body.sellerId,
      giftType: req.body.giftType,
      message: req.body.message,
      isAnonymous: req.body.isAnonymous,
      occasionType: req.body.occasionType,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  }
);
router.get("/gifts/fulfillment", requireAuth, (req, res) => {
  const user = req.auth?.user;
  const tasks = getFulfillmentTasks({
    sellerId: user?.sellerId || null,
    barId: user?.barId || null,
    isAdmin: user?.role === "admin",
  });
  res.json(tasks);
});
router.patch(
  "/gifts/fulfillment/:taskId",
  requireAuth,
  idempotencyOptional,
  rejectUnknownBodyKeys(["status"]),
  async (req, res) => {
    const result = await updateFulfillmentTaskStatus(req.params.taskId, req.body.status, req.auth.user.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  }
);

router.post(
  "/media/upload",
  requireAuth,
  requireRole("seller"),
  mediaUpload.single("file"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const isVideo = req.file.mimetype.startsWith("video/");
    res.json({
      ok: true,
      url: `/media/${req.file.filename}`,
      type: isVideo ? "video" : "image",
      originalName: req.file.originalname,
      size: req.file.size,
    });
  }
);

export default router;
