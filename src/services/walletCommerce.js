import { getState, replaceStateAndSeed } from "../db/store.js";

const MIN_WALLET_TOP_UP_THB = 500;
const SALE_SPLIT = {
  sellerWithBar: 0.7,
  sellerWithoutBar: 0.8,
  bar: 0.1
};

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

function removeBundlesContainingSoldItems(products, soldProductIds) {
  const soldSet = new Set(soldProductIds || []);
  return (products || []).filter((product) => {
    if (!product?.isBundle) return true;
    const bundleItems = Array.isArray(product.bundleItemIds) ? product.bundleItemIds : [];
    return !bundleItems.some((itemId) => soldSet.has(itemId));
  });
}

function calculateSplitForSeller(prev, { sellerId, grossAmount }) {
  const gross = round2(grossAmount);
  if (!sellerId || !Number.isFinite(gross) || gross <= 0) {
    return {
      sellerUserId: null,
      barUserId: null,
      adminUserId: null,
      sellerAmount: 0,
      barAmount: 0,
      adminAmount: 0,
      affiliatedBarId: null
    };
  }

  const seller = (prev.sellers || []).find((entry) => entry.id === sellerId);
  const sellerUser = (prev.users || []).find((entry) => entry.role === "seller" && entry.sellerId === sellerId);
  const affiliatedBarId = String(seller?.affiliatedBarId || "").trim();
  const barUser = affiliatedBarId
    ? (prev.users || []).find((entry) => entry.role === "bar" && entry.barId === affiliatedBarId)
    : null;
  const adminUser = (prev.users || []).find((entry) => entry.role === "admin");

  const hasPayoutBar = Boolean(barUser?.id);
  const sellerPct = hasPayoutBar ? SALE_SPLIT.sellerWithBar : SALE_SPLIT.sellerWithoutBar;
  const barPct = hasPayoutBar ? SALE_SPLIT.bar : 0;

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
    adminAmount,
    affiliatedBarId: hasPayoutBar ? affiliatedBarId : null
  };
}

export async function topUpWallet({ userId, amountThb }) {
  const amount = round2(amountThb);
  if (!Number.isFinite(amount) || amount < MIN_WALLET_TOP_UP_THB) {
    return {
      ok: false,
      code: 400,
      error: `Top-up amount must be at least ${MIN_WALLET_TOP_UP_THB} THB.`
    };
  }
  const prev = getState();
  const user = (prev.users || []).find((entry) => entry.id === userId);
  if (!user) {
    return { ok: false, code: 404, error: "User not found." };
  }
  if (user.role === "admin") {
    return { ok: false, code: 403, error: "Admin accounts cannot top up wallet." };
  }

  const now = new Date().toISOString();
  const nextBalance = round2((user.walletBalance || 0) + amount);
  const next = {
    ...prev,
    users: (prev.users || []).map((entry) => (
      entry.id === userId
        ? { ...entry, walletBalance: nextBalance }
        : entry
    )),
    walletTransactions: [
      {
        id: createTxnId("top_up"),
        userId,
        type: "top_up",
        amount,
        description: "Wallet top-up",
        createdAt: now
      },
      ...(prev.walletTransactions || [])
    ],
    stripeEvents: [
      {
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "wallet.top_up.completed",
        stripeSessionId: `wallet_${Date.now()}`,
        createdAt: now
      },
      ...(prev.stripeEvents || [])
    ]
  };

  await replaceStateAndSeed(next);
  return {
    ok: true,
    userId,
    amount,
    walletBalance: nextBalance,
    db: getState()
  };
}

export async function payCheckoutWithWallet({
  buyerUserId,
  itemIds,
  buyerEmail,
  shippingAddress,
  shippingCountry,
  shippingPostalCode,
  shippingMethod,
  shippingFee,
  saveAddressToProfile
}) {
  const uniqueItemIds = [...new Set(Array.isArray(itemIds) ? itemIds.filter(Boolean) : [])];
  if (!uniqueItemIds.length) {
    return { ok: false, code: 400, error: "At least one item is required." };
  }
  if (!String(shippingCountry || "").trim()) {
    return { ok: false, code: 400, error: "shippingCountry is required." };
  }
  if (!String(shippingPostalCode || "").trim()) {
    return { ok: false, code: 400, error: "shippingPostalCode is required." };
  }

  const parsedShippingFee = round2(shippingFee);
  if (!Number.isFinite(parsedShippingFee) || parsedShippingFee < 0) {
    return { ok: false, code: 400, error: "shippingFee must be a non-negative number." };
  }

  const prev = getState();
  const buyer = (prev.users || []).find((entry) => entry.id === buyerUserId);
  if (!buyer || buyer.role !== "buyer") {
    return { ok: false, code: 404, error: "Buyer account not found." };
  }
  if (buyer.accountStatus !== "active") {
    return { ok: false, code: 403, error: "Buyer account must be active." };
  }

  const productsById = Object.fromEntries((prev.products || []).map((product) => [product.id, product]));
  const purchasedProducts = uniqueItemIds.map((productId) => productsById[productId]).filter(Boolean);
  if (purchasedProducts.length !== uniqueItemIds.length) {
    return { ok: false, code: 404, error: "One or more items were not found." };
  }

  const subtotal = round2(
    purchasedProducts.reduce((sum, product) => sum + Number(product?.price || 0), 0)
  );
  const total = round2(subtotal + parsedShippingFee);
  const buyerBalance = round2(buyer.walletBalance);
  if (buyerBalance < total) {
    const shortfall = round2(total - buyerBalance);
    return {
      ok: false,
      code: 409,
      error: "Insufficient wallet balance for checkout.",
      shortfall,
      requiredTopUp: requiredTopUp(shortfall)
    };
  }

  const now = new Date().toISOString();
  const orderId = `order_${Date.now()}`;
  const sellerGrossBySellerId = {};
  for (const product of purchasedProducts) {
    const sellerId = product?.sellerId;
    const price = round2(product?.price || 0);
    if (!sellerId || price <= 0) continue;
    sellerGrossBySellerId[sellerId] = round2((sellerGrossBySellerId[sellerId] || 0) + price);
  }

  const sellerPayoutByUserId = {};
  const barPayoutByUserId = {};
  let adminPayoutTotal = 0;
  const payoutSummaryBySeller = [];
  let adminUserId = null;

  for (const [sellerId, sellerGross] of Object.entries(sellerGrossBySellerId)) {
    const split = calculateSplitForSeller(prev, { sellerId, grossAmount: sellerGross });
    if (split.sellerUserId && split.sellerAmount > 0) {
      sellerPayoutByUserId[split.sellerUserId] = round2(
        (sellerPayoutByUserId[split.sellerUserId] || 0) + split.sellerAmount
      );
    }
    if (split.barUserId && split.barAmount > 0) {
      barPayoutByUserId[split.barUserId] = round2(
        (barPayoutByUserId[split.barUserId] || 0) + split.barAmount
      );
    }
    if (split.adminUserId && split.adminAmount > 0) {
      adminUserId = split.adminUserId;
      adminPayoutTotal = round2(adminPayoutTotal + split.adminAmount);
    }
    const seller = (prev.sellers || []).find((entry) => entry.id === sellerId);
    payoutSummaryBySeller.push({
      sellerId,
      sellerName: seller?.name || sellerId,
      gross: sellerGross,
      sellerAmount: split.sellerAmount,
      barAmount: split.barAmount,
      adminAmount: split.adminAmount,
      barId: split.affiliatedBarId
    });
  }

  const shouldSaveAddress = saveAddressToProfile !== false;
  const normalizedAddress = String(shippingAddress || "").trim();
  const normalizedCountry = String(shippingCountry || "").trim();
  const normalizedPostal = String(shippingPostalCode || "").trim();
  const nextBuyerBalance = round2(buyerBalance - total);

  const next = {
    ...prev,
    users: (prev.users || []).map((entry) => {
      if (entry.id === buyerUserId) {
        return {
          ...entry,
          walletBalance: nextBuyerBalance,
          ...(shouldSaveAddress
            ? {
                address: normalizedAddress || entry.address || "",
                country: normalizedCountry || entry.country || "",
                postalCode: normalizedPostal || entry.postalCode || ""
              }
            : {})
        };
      }
      if (sellerPayoutByUserId[entry.id]) {
        return { ...entry, walletBalance: round2((entry.walletBalance || 0) + sellerPayoutByUserId[entry.id]) };
      }
      if (barPayoutByUserId[entry.id]) {
        return { ...entry, walletBalance: round2((entry.walletBalance || 0) + barPayoutByUserId[entry.id]) };
      }
      if (adminUserId && entry.id === adminUserId && adminPayoutTotal > 0) {
        return { ...entry, walletBalance: round2((entry.walletBalance || 0) + adminPayoutTotal) };
      }
      return entry;
    }),
    products: removeBundlesContainingSoldItems(
      (prev.products || []).filter((product) => !uniqueItemIds.includes(product.id)),
      uniqueItemIds
    ),
    orders: [
      {
        id: orderId,
        items: uniqueItemIds,
        buyerEmail: String(buyerEmail || buyer.email || "").trim(),
        buyerUserId,
        shippingAddress: normalizedAddress,
        shippingCountry: normalizedCountry,
        shippingPostalCode: normalizedPostal,
        shippingMethod: String(shippingMethod || "standard"),
        shippingFee: parsedShippingFee,
        total,
        stripeSessionId: "wallet_payment",
        paymentStatus: "paid",
        fulfillmentStatus: "processing",
        trackingNumber: "",
        payoutSummary: {
          productSubtotal: subtotal,
          shippingFee: parsedShippingFee,
          sellerTotal: round2(Object.values(sellerPayoutByUserId).reduce((sum, amount) => sum + amount, 0)),
          barTotal: round2(Object.values(barPayoutByUserId).reduce((sum, amount) => sum + amount, 0)),
          adminTotal: adminPayoutTotal,
          bySeller: payoutSummaryBySeller
        },
        createdAt: now
      },
      ...(prev.orders || [])
    ],
    walletTransactions: [
      ...Object.entries(sellerPayoutByUserId).map(([userId, amount]) => ({
        id: createTxnId(`order_seller_${userId}`),
        userId,
        type: "order_sale_earning",
        amount,
        description: `Seller payout for ${orderId}`,
        createdAt: now
      })),
      ...Object.entries(barPayoutByUserId).map(([userId, amount]) => ({
        id: createTxnId(`order_bar_${userId}`),
        userId,
        type: "order_bar_commission",
        amount,
        description: `Bar commission for ${orderId}`,
        createdAt: now
      })),
      ...(adminUserId && adminPayoutTotal > 0
        ? [{
            id: createTxnId(`order_admin_${adminUserId}`),
            userId: adminUserId,
            type: "order_platform_commission",
            amount: adminPayoutTotal,
            description: `Platform commission for ${orderId}`,
            createdAt: now
          }]
        : []),
      {
        id: createTxnId("order_buyer"),
        userId: buyerUserId,
        type: "order_payment",
        amount: -total,
        description: `Wallet purchase for ${orderId}`,
        createdAt: now
      },
      ...(prev.walletTransactions || [])
    ]
  };

  await replaceStateAndSeed(next);
  return {
    ok: true,
    orderId,
    total,
    subtotal,
    shippingFee: parsedShippingFee,
    walletBalance: nextBuyerBalance,
    db: getState()
  };
}
