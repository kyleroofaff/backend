import { getState, replaceStateAndSeed } from "../db/store.js";
import { hasPostgresConfig, withPgTransaction } from "../db/postgres.js";
import { dispatchPushNotification } from "./pushService.js";

const MIN_WALLET_TOP_UP_THB = 500;
const SALE_SPLIT = {
  sellerWithBar: 0.34,
  sellerWithoutBar: 0.5,
  bar: 0.33
};

function requiredTopUp(shortfall) {
  const value = Number(shortfall || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Number(Math.max(MIN_WALLET_TOP_UP_THB, value).toFixed(2));
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function createTxnId(suffix) {
  return `txn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}_${suffix}`;
}

function calculateSplit({ grossAmount, sellerUserId, barUserId, adminUserId }) {
  const gross = round2(grossAmount);
  const hasBar = Boolean(barUserId);
  const sellerPct = hasBar ? SALE_SPLIT.sellerWithBar : SALE_SPLIT.sellerWithoutBar;
  const barPct = hasBar ? SALE_SPLIT.bar : 0;
  let sellerAmount = sellerUserId ? round2(gross * sellerPct) : 0;
  let barAmount = barUserId ? round2(gross * barPct) : 0;
  let adminAmount = round2(gross - sellerAmount - barAmount);
  if (!adminUserId) {
    sellerAmount = round2(sellerAmount + adminAmount);
    adminAmount = 0;
  }
  return { sellerAmount, barAmount, adminAmount };
}

function buildAcceptanceState({ prev, request, buyerUser, sellerUser, adminUser, barUser, quotedPrice, now }) {
  const split = calculateSplit({
    grossAmount: quotedPrice,
    sellerUserId: sellerUser?.id || null,
    barUserId: barUser?.id || null,
    adminUserId: adminUser?.id || null
  });

  const nextUsers = (prev.users || []).map((user) => {
    if (user.id === buyerUser.id) {
      return { ...user, walletBalance: round2((user.walletBalance || 0) - quotedPrice) };
    }
    if (sellerUser?.id && user.id === sellerUser.id) {
      return { ...user, walletBalance: round2((user.walletBalance || 0) + split.sellerAmount) };
    }
    if (barUser?.id && user.id === barUser.id) {
      return { ...user, walletBalance: round2((user.walletBalance || 0) + split.barAmount) };
    }
    if (adminUser?.id && user.id === adminUser.id) {
      return { ...user, walletBalance: round2((user.walletBalance || 0) + split.adminAmount) };
    }
    return user;
  });

  const walletTransactions = [
    ...(split.sellerAmount > 0 && sellerUser?.id
      ? [{
          id: createTxnId("custom_seller"),
          userId: sellerUser.id,
          type: "order_payment",
          amount: split.sellerAmount,
          description: `Custom request quote accepted (${request.id})`,
          createdAt: now
        }]
      : []),
    ...(split.barAmount > 0 && barUser?.id
      ? [{
          id: createTxnId("custom_bar"),
          userId: barUser.id,
          type: "order_payment",
          amount: split.barAmount,
          description: `Bar commission for custom request (${request.id})`,
          createdAt: now
        }]
      : []),
    ...(split.adminAmount > 0 && adminUser?.id
      ? [{
          id: createTxnId("custom_admin"),
          userId: adminUser.id,
          type: "order_payment",
          amount: split.adminAmount,
          description: `Platform commission for custom request (${request.id})`,
          createdAt: now
        }]
      : []),
    {
      id: createTxnId("custom_buyer"),
      userId: buyerUser.id,
      type: "order_payment",
      amount: -quotedPrice,
      description: `Accepted custom request quote (${request.id})`,
      createdAt: now
    },
    ...(prev.walletTransactions || [])
  ];

  const customRequests = (prev.customRequests || []).map((entry) => (
    entry.id === request.id
      ? {
          ...entry,
          quoteStatus: "accepted",
          quoteAcceptedAt: now,
          quoteUpdatedAt: now,
          quoteUpdatedByUserId: buyerUser.id,
          quoteAwaitingBuyerPayment: false,
          status: entry.status === "open" ? "reviewing" : entry.status,
          updatedAt: now
        }
      : entry
  ));

  const customRequestMessages = [
    ...(prev.customRequestMessages || []),
    {
      id: `custom_request_msg_${Date.now()}_accept_api`,
      requestId: request.id,
      senderUserId: buyerUser.id,
      senderRole: "buyer",
      body: `I accept your quote of ${quotedPrice} THB. Payment sent.`,
      feeCharged: 0,
      messageType: "price_accept",
      quotedPriceThb: quotedPrice,
      createdAt: now
    }
  ];

  const notifications = sellerUser?.id
    ? [
        ...(prev.notifications || []),
        {
          id: `notif_${Date.now()}_quote_accept_api`,
          userId: sellerUser.id,
          type: "engagement",
          text: `${buyerUser.name || "Buyer"} accepted your quote and paid ${quotedPrice} THB.`,
          read: false,
          createdAt: now
        }
      ]
    : (prev.notifications || []);

  return {
    next: {
      ...prev,
      users: nextUsers,
      walletTransactions,
      customRequests,
      customRequestMessages,
      notifications
    },
    split
  };
}

async function acceptInState({ requestId, buyerUserId }) {
  const prev = getState();
  const request = (prev.customRequests || []).find((entry) => entry.id === requestId && entry.buyerUserId === buyerUserId);
  if (!request) {
    return { ok: false, code: 404, error: "Custom request not found." };
  }
  const quotedPrice = round2(request.quotedPriceThb);
  if (!Number.isFinite(quotedPrice) || quotedPrice <= 0) {
    return { ok: false, code: 409, error: "No payable quote is currently available." };
  }
  if (String(request.quoteStatus || "").toLowerCase() === "accepted") {
    return { ok: true, alreadyProcessed: true, requestId, quotedPrice };
  }

  const buyerUser = (prev.users || []).find((entry) => entry.id === buyerUserId);
  if (!buyerUser) {
    return { ok: false, code: 404, error: "Buyer account not found." };
  }
  const buyerBalance = round2(buyerUser.walletBalance);
  if (buyerBalance < quotedPrice) {
    const shortfall = round2(quotedPrice - buyerBalance);
    return {
      ok: false,
      code: 409,
      error: `Insufficient wallet balance. Need ${quotedPrice} THB.`,
      shortfall,
      requiredTopUp: requiredTopUp(shortfall)
    };
  }

  const sellerUser = (prev.users || []).find(
    (entry) => entry.role === "seller" && entry.sellerId === request.sellerId
  );
  const seller = (prev.sellers || []).find((entry) => entry.id === request.sellerId);
  const barUser = seller?.affiliatedBarId
    ? (prev.users || []).find((entry) => entry.role === "bar" && entry.barId === seller.affiliatedBarId)
    : null;
  const adminUser = (prev.users || []).find((entry) => entry.role === "admin");
  const now = new Date().toISOString();
  const { next, split } = buildAcceptanceState({
    prev,
    request,
    buyerUser,
    sellerUser,
    adminUser,
    barUser,
    quotedPrice,
    now
  });
  await replaceStateAndSeed(next);

  return {
    ok: true,
    requestId,
    quotedPrice,
    payout: split,
    sellerUserId: sellerUser?.id || null
  };
}

async function acceptInPostgres({ requestId, buyerUserId }) {
  return withPgTransaction(async (client) => {
    const requestResult = await client.query(
      `SELECT id, seller_id, buyer_user_id, quote_status, quoted_price_thb, status
       FROM custom_requests
       WHERE id = $1 AND buyer_user_id = $2
       FOR UPDATE`,
      [requestId, buyerUserId]
    );
    const request = requestResult.rows[0];
    if (!request) {
      return { ok: false, code: 404, error: "Custom request not found." };
    }

    const quotedPrice = round2(request.quoted_price_thb);
    if (!Number.isFinite(quotedPrice) || quotedPrice <= 0) {
      return { ok: false, code: 409, error: "No payable quote is currently available." };
    }

    if (String(request.quote_status || "").toLowerCase() === "accepted") {
      return { ok: true, alreadyProcessed: true, requestId, quotedPrice };
    }

    const buyerResult = await client.query(
      `SELECT id, name, wallet_balance FROM app_users WHERE id = $1 FOR UPDATE`,
      [buyerUserId]
    );
    const buyerUser = buyerResult.rows[0];
    if (!buyerUser) {
      return { ok: false, code: 404, error: "Buyer account not found." };
    }
    const buyerBalance = round2(buyerUser.wallet_balance);
    if (buyerBalance < quotedPrice) {
      const shortfall = round2(quotedPrice - buyerBalance);
      return {
        ok: false,
        code: 409,
        error: `Insufficient wallet balance. Need ${quotedPrice} THB.`,
        shortfall,
        requiredTopUp: requiredTopUp(shortfall)
      };
    }

    const sellerResult = await client.query(
      `SELECT id FROM app_users WHERE role = 'seller' AND seller_id = $1 FOR UPDATE`,
      [request.seller_id]
    );
    const adminResult = await client.query(
      `SELECT id FROM app_users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1 FOR UPDATE`
    );
    const sellerUserId = sellerResult.rows[0]?.id || null;
    const adminUserId = adminResult.rows[0]?.id || null;
    const split = calculateSplit({
      grossAmount: quotedPrice,
      sellerUserId,
      barUserId: null,
      adminUserId
    });

    await client.query(
      "UPDATE app_users SET wallet_balance = wallet_balance - $2 WHERE id = $1",
      [buyerUserId, quotedPrice]
    );
    if (sellerUserId && split.sellerAmount > 0) {
      await client.query(
        "UPDATE app_users SET wallet_balance = wallet_balance + $2 WHERE id = $1",
        [sellerUserId, split.sellerAmount]
      );
    }
    if (adminUserId && split.adminAmount > 0) {
      await client.query(
        "UPDATE app_users SET wallet_balance = wallet_balance + $2 WHERE id = $1",
        [adminUserId, split.adminAmount]
      );
    }

    await client.query(
      `UPDATE custom_requests
       SET quote_status = 'accepted',
           status = CASE WHEN status = 'open' THEN 'reviewing' ELSE status END,
           updated_at = NOW()
       WHERE id = $1`,
      [requestId]
    );

    const txInserts = [
      ...(sellerUserId && split.sellerAmount > 0
        ? [[createTxnId("pg_custom_seller"), sellerUserId, "order_payment", split.sellerAmount, `Custom request quote accepted (${requestId})`]]
        : []),
      ...(adminUserId && split.adminAmount > 0
        ? [[createTxnId("pg_custom_admin"), adminUserId, "order_payment", split.adminAmount, `Platform commission for custom request (${requestId})`]]
        : []),
      [createTxnId("pg_custom_buyer"), buyerUserId, "order_payment", -quotedPrice, `Accepted custom request quote (${requestId})`]
    ];

    for (const row of txInserts) {
      await client.query(
        `INSERT INTO wallet_transactions (id, user_id, type, amount_thb, description)
         VALUES ($1,$2,$3,$4,$5)`,
        row
      );
    }

    return {
      ok: true,
      requestId,
      quotedPrice,
      payout: split,
      sellerUserId: sellerUserId || null
    };
  });
}

export async function acceptCustomRequestQuote({ requestId, buyerUserId }) {
  const result = hasPostgresConfig()
    ? await acceptInPostgres({ requestId, buyerUserId })
    : await acceptInState({ requestId, buyerUserId });

  if (result?.ok && result.sellerUserId && !result.alreadyProcessed) {
    await dispatchPushNotification({
      userId: result.sellerUserId,
      preferenceType: "engagement",
      route: `/custom-requests?requestId=${encodeURIComponent(requestId)}`,
      titleByLang: {
        en: "Custom request quote accepted",
        th: "คำเสนอราคาคำขอพิเศษได้รับการยอมรับแล้ว",
        my: "Custom request စျေးနှုန်းကို လက်ခံပြီးပါပြီ",
        ru: "Предложение по индивидуальному запросу принято"
      },
      bodyByLang: {
        en: `Buyer accepted your quote for request ${requestId}.`,
        th: `ผู้ซื้อยอมรับราคาของคุณสำหรับคำขอ ${requestId} แล้ว`,
        my: `ဝယ်သူသည် request ${requestId} အတွက် သင့်စျေးနှုန်းကို လက်ခံခဲ့သည်။`,
        ru: `Покупатель принял вашу цену по запросу ${requestId}.`
      },
      data: {
        kind: "custom_request_quote_accepted",
        requestId
      }
    }).catch(() => {});
  }
  if (result?.ok && !result.alreadyProcessed) {
    const adminUser = (getState().users || []).find((entry) => entry.role === "admin" && entry.accountStatus === "active");
    if (adminUser?.id) {
      await dispatchPushNotification({
        userId: adminUser.id,
        preferenceType: "adminOps",
        route: `/admin?tab=custom_requests&requestId=${encodeURIComponent(requestId)}`,
        titleByLang: {
          en: "Custom quote paid",
          th: "ชำระราคาคำขอพิเศษแล้ว",
          my: "Custom quote ကို ငွေပေးချေပြီးပါပြီ",
          ru: "Оплачен индивидуальный оффер"
        },
        bodyByLang: {
          en: `Buyer accepted and paid quote for request ${requestId}.`,
          th: `ผู้ซื้อยอมรับและชำระราคาสำหรับคำขอ ${requestId} แล้ว`,
          my: `ဝယ်သူသည် request ${requestId} အတွက် quote ကို လက်ခံပြီး ပေးချေခဲ့သည်။`,
          ru: `Покупатель принял(а) и оплатил(а) оффер по запросу ${requestId}.`
        },
        data: {
          kind: "payment_custom_request_quote_accepted",
          requestId
        }
      }).catch(() => {});
    }
  }
  return result;
}
