import { getState, replaceStateAndSeed } from "../db/store.js";
import { dispatchPushNotification } from "./pushService.js";

const MESSAGE_FEE_THB = 7;
const CUSTOM_REQUEST_FEE_THB = 7;
const MIN_WALLET_TOP_UP_THB = 500;
const SALE_SPLIT = {
  sellerWithBar: 0.7,
  sellerWithoutBar: 0.8,
  bar: 0.1
};

function buildLocalizedMessageTemplates(senderName, conversationId) {
  return {
    titleByLang: {
      en: "New buyer message",
      th: "มีข้อความใหม่จากผู้ซื้อ",
      my: "ဝယ်သူထံမှ မက်ဆေ့ချ်အသစ်",
      ru: "Новое сообщение от покупателя"
    },
    bodyByLang: {
      en: `${senderName} sent a new message. Conversation: ${conversationId}`,
      th: `${senderName} ส่งข้อความใหม่แล้ว บทสนทนา: ${conversationId}`,
      my: `${senderName} က မက်ဆေ့ချ်အသစ်ပို့ထားသည်။ စကားပြောခန်း: ${conversationId}`,
      ru: `${senderName} отправил(а) новое сообщение. Диалог: ${conversationId}`
    }
  };
}

function buildLocalizedCustomRequestTemplates(senderName, requestId) {
  return {
    titleByLang: {
      en: "New custom request",
      th: "คำขอพิเศษใหม่",
      my: "Custom request အသစ်",
      ru: "Новый индивидуальный запрос"
    },
    bodyByLang: {
      en: `${senderName} created a custom request (${requestId}).`,
      th: `${senderName} สร้างคำขอพิเศษ (${requestId})`,
      my: `${senderName} သည် custom request တစ်ခု (${requestId}) ဖန်တီးခဲ့သည်။`,
      ru: `${senderName} создал(а) индивидуальный запрос (${requestId}).`
    }
  };
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function requiredTopUp(shortfall) {
  const value = Number(shortfall || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return round2(Math.max(MIN_WALLET_TOP_UP_THB, value));
}

function createTxnId(suffix) {
  return `txn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}_${suffix}`;
}

function calculateSplit(prev, { sellerId, grossAmount }) {
  const gross = round2(grossAmount);
  if (!sellerId || !Number.isFinite(gross) || gross <= 0) {
    return {
      sellerUserId: null,
      barUserId: null,
      adminUserId: null,
      sellerAmount: 0,
      barAmount: 0,
      adminAmount: 0
    };
  }
  const seller = (prev.sellers || []).find((entry) => entry.id === sellerId);
  const sellerUser = (prev.users || []).find((entry) => entry.role === "seller" && entry.sellerId === sellerId);
  const affiliatedBarId = String(seller?.affiliatedBarId || "").trim();
  const barUser = affiliatedBarId
    ? (prev.users || []).find((entry) => entry.role === "bar" && entry.barId === affiliatedBarId)
    : null;
  const adminUser = (prev.users || []).find((entry) => entry.role === "admin");

  const hasBar = Boolean(barUser?.id);
  const sellerPct = hasBar ? SALE_SPLIT.sellerWithBar : SALE_SPLIT.sellerWithoutBar;
  const barPct = hasBar ? SALE_SPLIT.bar : 0;
  let sellerAmount = round2(gross * sellerPct);
  let barAmount = round2(gross * barPct);
  let adminAmount = round2(gross - sellerAmount - barAmount);

  if (!sellerUser?.id) {
    adminAmount = round2(adminAmount + sellerAmount);
    sellerAmount = 0;
  }
  if (!barUser?.id) {
    adminAmount = round2(adminAmount + barAmount);
    barAmount = 0;
  }
  return {
    sellerUserId: sellerUser?.id || null,
    barUserId: barUser?.id || null,
    adminUserId: adminUser?.id || null,
    sellerAmount,
    barAmount,
    adminAmount
  };
}

export async function sendBuyerPaidMessage({ buyerUserId, sellerId, conversationId, body }) {
  const messageText = String(body || "").trim();
  if (!buyerUserId || !sellerId || !conversationId || !messageText) {
    return { ok: false, code: 400, error: "sellerId, conversationId, and body are required." };
  }
  const prev = getState();
  const buyer = (prev.users || []).find((entry) => entry.id === buyerUserId && entry.role === "buyer");
  if (!buyer) {
    return { ok: false, code: 404, error: "Buyer account not found." };
  }
  if (buyer.accountStatus !== "active") {
    return { ok: false, code: 403, error: "Buyer account must be active." };
  }

  const buyerBalance = round2(buyer.walletBalance);
  if (buyerBalance < MESSAGE_FEE_THB) {
    const shortfall = round2(MESSAGE_FEE_THB - buyerBalance);
    return {
      ok: false,
      code: 409,
      error: "Insufficient wallet balance for message fee.",
      shortfall,
      requiredTopUp: requiredTopUp(shortfall)
    };
  }

  const sellerUser = (prev.users || []).find((entry) => entry.role === "seller" && entry.sellerId === sellerId) || null;
  const now = new Date().toISOString();
  const payout = calculateSplit(prev, { sellerId, grossAmount: MESSAGE_FEE_THB });
  const nextBuyerBalance = round2(buyerBalance - MESSAGE_FEE_THB);

  const next = {
    ...prev,
    users: (prev.users || []).map((entry) => {
      if (entry.id === buyerUserId) return { ...entry, walletBalance: nextBuyerBalance };
      if (payout.sellerUserId && entry.id === payout.sellerUserId) {
        return { ...entry, walletBalance: round2((entry.walletBalance || 0) + payout.sellerAmount) };
      }
      if (payout.barUserId && entry.id === payout.barUserId) {
        return { ...entry, walletBalance: round2((entry.walletBalance || 0) + payout.barAmount) };
      }
      if (payout.adminUserId && entry.id === payout.adminUserId) {
        return { ...entry, walletBalance: round2((entry.walletBalance || 0) + payout.adminAmount) };
      }
      return entry;
    }),
    walletTransactions: [
      ...(payout.sellerUserId && payout.sellerAmount > 0
        ? [{
            id: createTxnId("message_seller"),
            userId: payout.sellerUserId,
            type: "message_fee",
            amount: payout.sellerAmount,
            description: `Message earning from ${buyer.name || "Buyer"}`,
            createdAt: now
          }]
        : []),
      ...(payout.barUserId && payout.barAmount > 0
        ? [{
            id: createTxnId("message_bar"),
            userId: payout.barUserId,
            type: "message_fee",
            amount: payout.barAmount,
            description: "Bar commission from buyer message fee",
            createdAt: now
          }]
        : []),
      ...(payout.adminUserId && payout.adminAmount > 0
        ? [{
            id: createTxnId("message_admin"),
            userId: payout.adminUserId,
            type: "message_fee",
            amount: payout.adminAmount,
            description: "Platform commission from buyer message fee",
            createdAt: now
          }]
        : []),
      {
        id: createTxnId("message_buyer"),
        userId: buyerUserId,
        type: "message_fee",
        amount: -MESSAGE_FEE_THB,
        description: `Message fee to ${sellerUser?.name || "Seller"}`,
        createdAt: now
      },
      ...(prev.walletTransactions || [])
    ],
    messages: [
      ...(prev.messages || []),
      {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        conversationId,
        buyerId: buyerUserId,
        sellerId,
        senderId: buyerUserId,
        senderRole: "buyer",
        body: messageText,
        bodyOriginal: messageText,
        sourceLanguage: "en",
        translations: { en: messageText },
        feeCharged: MESSAGE_FEE_THB,
        createdAt: now,
        readByBuyer: true,
        readBySeller: false
      }
    ],
    notifications: sellerUser?.id
      ? [
          ...(prev.notifications || []),
          {
            id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            userId: sellerUser.id,
            type: "message",
            text: `New buyer message from ${buyer.name || "Buyer"}.`,
            conversationId,
            read: false,
            createdAt: now
          }
        ]
      : (prev.notifications || [])
  };

  await replaceStateAndSeed(next);
  if (sellerUser?.id) {
    const templates = buildLocalizedMessageTemplates(buyer.name || "Buyer", conversationId);
    await dispatchPushNotification({
      userId: sellerUser.id,
      preferenceType: "message",
      route: `/account?scope=seller&conversationId=${encodeURIComponent(conversationId)}`,
      titleByLang: templates.titleByLang,
      bodyByLang: templates.bodyByLang,
      data: {
        kind: "buyer_message_received",
        conversationId
      }
    }).catch(() => {});
  }
  return {
    ok: true,
    walletBalance: nextBuyerBalance,
    db: getState()
  };
}

export async function createBuyerCustomRequest({
  buyerUserId,
  sellerId,
  buyerName,
  buyerEmail,
  preferredDetails,
  shippingCountry,
  requestBody
}) {
  const normalizedSellerId = String(sellerId || "").trim();
  const normalizedBuyerName = String(buyerName || "").trim();
  const normalizedBuyerEmail = String(buyerEmail || "").trim().toLowerCase();
  const normalizedPreferredDetails = String(preferredDetails || "").trim();
  const normalizedShippingCountry = String(shippingCountry || "").trim();
  const normalizedRequestBody = String(requestBody || "").trim();
  if (!buyerUserId || !normalizedSellerId || !normalizedBuyerName || !normalizedBuyerEmail || !normalizedPreferredDetails || !normalizedRequestBody) {
    return { ok: false, code: 400, error: "All required custom request fields must be provided." };
  }

  const prev = getState();
  const buyer = (prev.users || []).find((entry) => entry.id === buyerUserId && entry.role === "buyer");
  if (!buyer) {
    return { ok: false, code: 404, error: "Buyer account not found." };
  }
  if (buyer.accountStatus !== "active") {
    return { ok: false, code: 403, error: "Buyer account must be active." };
  }
  const buyerBalance = round2(buyer.walletBalance);
  if (buyerBalance < CUSTOM_REQUEST_FEE_THB) {
    const shortfall = round2(CUSTOM_REQUEST_FEE_THB - buyerBalance);
    return {
      ok: false,
      code: 409,
      error: "Insufficient wallet balance for custom request fee.",
      shortfall,
      requiredTopUp: requiredTopUp(shortfall)
    };
  }

  const sellerUser = (prev.users || []).find((entry) => entry.role === "seller" && entry.sellerId === normalizedSellerId) || null;
  const now = new Date().toISOString();
  const requestId = `custom_request_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const payout = calculateSplit(prev, { sellerId: normalizedSellerId, grossAmount: CUSTOM_REQUEST_FEE_THB });
  const nextBuyerBalance = round2(buyerBalance - CUSTOM_REQUEST_FEE_THB);

  const next = {
    ...prev,
    users: (prev.users || []).map((entry) => {
      if (entry.id === buyerUserId) return { ...entry, walletBalance: nextBuyerBalance };
      if (payout.sellerUserId && entry.id === payout.sellerUserId) {
        return { ...entry, walletBalance: round2((entry.walletBalance || 0) + payout.sellerAmount) };
      }
      if (payout.barUserId && entry.id === payout.barUserId) {
        return { ...entry, walletBalance: round2((entry.walletBalance || 0) + payout.barAmount) };
      }
      if (payout.adminUserId && entry.id === payout.adminUserId) {
        return { ...entry, walletBalance: round2((entry.walletBalance || 0) + payout.adminAmount) };
      }
      return entry;
    }),
    walletTransactions: [
      ...(payout.sellerUserId && payout.sellerAmount > 0
        ? [{
            id: createTxnId("custom_req_seller"),
            userId: payout.sellerUserId,
            type: "message_fee",
            amount: payout.sellerAmount,
            description: `Custom request earning from ${normalizedBuyerName || "Buyer"}`,
            createdAt: now
          }]
        : []),
      ...(payout.barUserId && payout.barAmount > 0
        ? [{
            id: createTxnId("custom_req_bar"),
            userId: payout.barUserId,
            type: "message_fee",
            amount: payout.barAmount,
            description: "Bar commission from custom request fee",
            createdAt: now
          }]
        : []),
      ...(payout.adminUserId && payout.adminAmount > 0
        ? [{
            id: createTxnId("custom_req_admin"),
            userId: payout.adminUserId,
            type: "message_fee",
            amount: payout.adminAmount,
            description: "Platform commission from custom request fee",
            createdAt: now
          }]
        : []),
      {
        id: createTxnId("custom_req_buyer"),
        userId: buyerUserId,
        type: "message_fee",
        amount: -CUSTOM_REQUEST_FEE_THB,
        description: `Custom request fee to ${sellerUser?.name || "Seller"}`,
        createdAt: now
      },
      ...(prev.walletTransactions || [])
    ],
    customRequests: [
      {
        id: requestId,
        buyerUserId,
        sellerId: normalizedSellerId,
        buyerName: normalizedBuyerName,
        buyerEmail: normalizedBuyerEmail,
        preferredDetails: normalizedPreferredDetails,
        shippingCountry: normalizedShippingCountry,
        requestBody: normalizedRequestBody,
        status: "open",
        quotedPriceThb: null,
        quoteStatus: "none",
        quoteMessage: "",
        quoteUpdatedAt: null,
        quoteUpdatedByUserId: null,
        quoteAcceptedAt: null,
        buyerCounterPriceThb: null,
        quoteAwaitingBuyerPayment: false,
        buyerImageUploadEnabled: false,
        createdAt: now,
        updatedAt: now
      },
      ...(prev.customRequests || [])
    ],
    notifications: sellerUser?.id
      ? [
          ...(prev.notifications || []),
          {
            id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            userId: sellerUser.id,
            type: "message",
            text: `New custom request from ${normalizedBuyerName}.`,
            read: false,
            createdAt: now
          }
        ]
      : (prev.notifications || [])
  };

  await replaceStateAndSeed(next);
  if (sellerUser?.id) {
    const templates = buildLocalizedCustomRequestTemplates(normalizedBuyerName || "Buyer", requestId);
    await dispatchPushNotification({
      userId: sellerUser.id,
      preferenceType: "message",
      route: `/custom-requests?requestId=${encodeURIComponent(requestId)}`,
      titleByLang: templates.titleByLang,
      bodyByLang: templates.bodyByLang,
      data: {
        kind: "custom_request_created",
        requestId
      }
    }).catch(() => {});
  }
  return {
    ok: true,
    requestId,
    walletBalance: nextBuyerBalance,
    db: getState()
  };
}
