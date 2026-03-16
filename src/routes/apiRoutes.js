import { Router } from "express";
import { login, me } from "../controllers/authController.js";
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
  walletTopUp,
  walletReconciliation
} from "../controllers/marketplaceController.js";
import { requireAuth, requireNonProduction, requireRole } from "../middlewares/auth.js";
import { rejectUnknownBodyKeys, strictAuthRateLimit } from "../middlewares/security.js";
import { idempotencyOptional, requireIdempotencyKey } from "../middlewares/idempotency.js";

const router = Router();

router.get("/health", health);
router.get("/health/ready", readiness);
router.get("/push/config", pushConfig);
router.post("/auth/login", strictAuthRateLimit, rejectUnknownBodyKeys(["email", "password"]), login);
router.get("/auth/me", requireAuth, me);
router.post("/push/subscribe", requireAuth, rejectUnknownBodyKeys(["subscription"]), subscribePush);
router.post("/push/unsubscribe", requireAuth, rejectUnknownBodyKeys(["endpoint"]), unsubscribePush);
router.post("/push/preferences", requireAuth, rejectUnknownBodyKeys(["push"]), updatePushPreferences);
router.get("/bootstrap", getBootstrap);
router.post("/state", requireAuth, requireRole("admin"), requireNonProduction, idempotencyOptional, rejectUnknownBodyKeys(["db"]), saveState);
router.post("/reset", requireAuth, requireRole("admin"), requireNonProduction, idempotencyOptional, reset);
router.get("/products", getProducts);
router.delete("/products/:productId", requireAuth, requireRole("seller", "admin"), idempotencyOptional, rejectUnknownBodyKeys(["productTitle"]), deleteProduct);
router.get("/sellers", getSellers);
router.get("/seller-posts", getSellerPosts);
router.post("/seller-posts", requireAuth, requireRole("seller"), idempotencyOptional, rejectUnknownBodyKeys(["image", "imageName", "caption", "captionI18n", "visibility", "accessPriceUsd"]), createSellerPost);
router.delete("/seller-posts/:postId", requireAuth, requireRole("seller", "admin"), idempotencyOptional, deleteSellerPost);
router.post("/seller-posts/:postId/report", requireAuth, requireRole("buyer", "seller", "admin"), idempotencyOptional, rejectUnknownBodyKeys(["reason"]), reportSellerPost);
router.get("/seller-post-reports", requireAuth, requireRole("admin"), getPostReports);
router.post("/seller-post-reports/:reportId/resolve", requireAuth, requireRole("admin"), idempotencyOptional, resolvePostReport);
router.post("/notifications/seller-approval-request", requireAuth, requireRole("admin"), idempotencyOptional, rejectUnknownBodyKeys(["sellerName", "sellerEmail", "requestedAt"]), notifySellerApprovalRequest);
router.post("/notifications/platform-email", requireAuth, requireRole("admin"), idempotencyOptional, rejectUnknownBodyKeys(["toEmail", "toName", "subject", "text", "templateKey", "actionUrl"]), notifyPlatformEmail);
router.post("/translate", requireAuth, idempotencyOptional, rejectUnknownBodyKeys(["text", "targetLang"]), translateText);
router.get("/reconciliation/wallet", requireAuth, requireRole("admin"), walletReconciliation);
router.post(
  "/messages/buyer-send",
  requireAuth,
  requireRole("buyer"),
  requireIdempotencyKey,
  idempotencyOptional,
  rejectUnknownBodyKeys(["sellerId", "conversationId", "body"]),
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

export default router;
