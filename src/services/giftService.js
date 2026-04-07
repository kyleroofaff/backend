import { getState, replaceStateAndSeed } from "../db/store.js";

const DEFAULT_GIFT_CATALOG = [
  { id: "gift_rose", type: "rose", name: "Rose", price: 200, reserveCost: 50, fulfillmentType: "physical", isActive: true },
  { id: "gift_dozen_roses", type: "dozen_roses", name: "Dozen Roses", price: 2000, reserveCost: 500, fulfillmentType: "physical", isActive: true },
  { id: "gift_chocolate", type: "chocolate", name: "Chocolate", price: 1650, reserveCost: 400, fulfillmentType: "physical", isActive: true },
  {
    id: "gift_drink", type: "drink", name: "Drink", price: 350, reserveCost: 0, fulfillmentType: "drink", isActive: true,
    drinkSplit: { bar: 150, seller: 100, admin: 50 },
  },
];

function getCatalog(state) {
  const catalog = Array.isArray(state.giftCatalog) && state.giftCatalog.length > 0
    ? state.giftCatalog
    : DEFAULT_GIFT_CATALOG;
  return catalog;
}

export function getActiveCatalog() {
  return getCatalog(getState()).filter((g) => g.isActive);
}

export function getFullCatalog() {
  return getCatalog(getState());
}

export async function updateCatalogItem(giftId, { isActive, price }) {
  const state = getState();
  let catalog = getCatalog(state).map((item) => ({ ...item }));
  const idx = catalog.findIndex((g) => g.id === giftId);
  if (idx < 0) return { ok: false, error: "Gift item not found." };
  if (isActive !== undefined) catalog[idx].isActive = Boolean(isActive);
  if (price !== undefined) {
    const parsed = Number(price);
    if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, error: "Invalid price." };
    catalog[idx].price = parsed;
  }
  await replaceStateAndSeed({ ...state, giftCatalog: catalog });
  return { ok: true, item: catalog[idx] };
}

export async function purchaseGift({ buyerUserId, sellerId, giftType, message, isAnonymous, occasionType }) {
  const state = getState();
  const catalog = getCatalog(state);
  const giftItem = catalog.find((g) => g.type === giftType && g.isActive);
  if (!giftItem) return { ok: false, error: "Gift type not available." };

  const users = Array.isArray(state.users) ? state.users : [];
  const buyer = users.find((u) => u.id === buyerUserId);
  if (!buyer) return { ok: false, error: "Buyer not found." };

  const balance = Number(buyer.walletBalance || 0);
  if (balance < giftItem.price) return { ok: false, error: "Insufficient wallet balance." };

  const sellers = Array.isArray(state.sellers) ? state.sellers : [];
  const seller = sellers.find((s) => s.id === sellerId);
  if (!seller) return { ok: false, error: "Seller not found." };

  if (giftItem.fulfillmentType === "drink" && !seller.affiliatedBarId) {
    return { ok: false, error: "Drinks are only available for bar-affiliated sellers." };
  }

  if (Array.isArray(seller.disabledGiftTypes) && seller.disabledGiftTypes.includes(giftItem.type)) {
    return { ok: false, error: "This seller does not accept this gift type." };
  }

  const now = new Date().toISOString();
  const purchaseId = `gift_purchase_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  let barCut = 0, sellerCut = 0, adminCut = giftItem.price;
  if (giftItem.fulfillmentType === "drink" && giftItem.drinkSplit) {
    barCut = giftItem.drinkSplit.bar;
    sellerCut = giftItem.drinkSplit.seller;
    adminCut = giftItem.price - barCut - sellerCut;
  }

  const purchase = {
    id: purchaseId,
    buyerId: buyerUserId,
    sellerId,
    giftType: giftItem.type,
    catalogId: giftItem.id,
    price: giftItem.price,
    reserveCost: giftItem.reserveCost,
    message: String(message || "").trim().slice(0, 500),
    isAnonymous: Boolean(isAnonymous),
    occasionType: String(occasionType || "").trim(),
    fulfillmentType: giftItem.fulfillmentType,
    status: "pending",
    barCut,
    sellerCut,
    adminCut,
    createdAt: now,
  };

  const updatedUsers = users.map((u) => {
    if (u.id === buyerUserId) return { ...u, walletBalance: Number(((Number(u.walletBalance || 0) - giftItem.price)).toFixed(2)) };
    return u;
  });

  const walletTxns = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
  const newTxns = [
    { id: `wtxn_${Date.now()}_gift_debit`, userId: buyerUserId, amount: -giftItem.price, type: "gift_purchase", description: `Purchased ${giftItem.name} for seller`, relatedId: purchaseId, createdAt: now },
  ];

  if (giftItem.fulfillmentType === "drink" && giftItem.drinkSplit) {
    const sellerUser = users.find((u) => u.role === "seller" && u.sellerId === sellerId);
    if (sellerUser) {
      const updatedSeller = updatedUsers.find((u) => u.id === sellerUser.id);
      if (updatedSeller) updatedSeller.walletBalance = Number(((Number(updatedSeller.walletBalance || 0) + sellerCut)).toFixed(2));
      newTxns.push({ id: `wtxn_${Date.now()}_gift_seller`, userId: sellerUser.id, amount: sellerCut, type: "gift_drink_seller", description: `Drink gift seller cut`, relatedId: purchaseId, createdAt: now });
    }
    if (seller.affiliatedBarId) {
      const barUser = users.find((u) => u.role === "bar" && u.barId === seller.affiliatedBarId);
      if (barUser) {
        const updatedBarUser = updatedUsers.find((u) => u.id === barUser.id);
        if (updatedBarUser) updatedBarUser.walletBalance = Number(((Number(updatedBarUser.walletBalance || 0) + barCut)).toFixed(2));
        newTxns.push({ id: `wtxn_${Date.now()}_gift_bar`, userId: barUser.id, amount: barCut, type: "gift_drink_bar", description: `Drink gift bar cut`, relatedId: purchaseId, createdAt: now });
      }
    }
    newTxns.push({ id: `wtxn_${Date.now()}_gift_admin`, userId: "admin-1", amount: adminCut, type: "gift_drink_admin", description: `Drink gift admin cut`, relatedId: purchaseId, createdAt: now });
  } else {
    newTxns.push({ id: `wtxn_${Date.now()}_gift_admin_full`, userId: "admin-1", amount: giftItem.price, type: "gift_admin_revenue", description: `${giftItem.name} gift revenue`, relatedId: purchaseId, createdAt: now });
  }

  let assigneeType = "seller";
  let barId = null;
  if (giftItem.fulfillmentType === "drink" && seller.affiliatedBarId) {
    assigneeType = "bar";
    barId = seller.affiliatedBarId;
  }

  const fulfillmentTask = {
    id: `gift_task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    giftPurchaseId: purchaseId,
    sellerId,
    barId,
    assigneeType,
    taskType: giftItem.fulfillmentType,
    status: "pending",
    createdAt: now,
  };

  const notifications = Array.isArray(state.notifications) ? state.notifications : [];
  const buyerName = isAnonymous ? "Anonymous" : (buyer.name || "A buyer");
  const newNotifications = [
    {
      id: `notif_gift_${Date.now()}_seller`,
      userId: users.find((u) => u.role === "seller" && u.sellerId === sellerId)?.id,
      type: "gift_received",
      title: { en: `You received a ${giftItem.name}!`, th: `คุณได้รับ ${giftItem.name}!` },
      body: { en: `${buyerName} sent you a ${giftItem.name}.${message ? ` "${message}"` : ""}` },
      route: "/account",
      read: false,
      createdAt: now,
    },
  ].filter((n) => n.userId);

  if (assigneeType === "bar" && barId) {
    const barUser = users.find((u) => u.role === "bar" && u.barId === barId);
    if (barUser) {
      newNotifications.push({
        id: `notif_gift_${Date.now()}_bar`,
        userId: barUser.id,
        type: "gift_fulfillment",
        title: { en: `New drink to deliver`, th: `มีเครื่องดื่มใหม่ต้องส่ง` },
        body: { en: `A drink gift was purchased for ${seller.name || sellerId}. Please deliver.` },
        route: "/account",
        read: false,
        createdAt: now,
      });
    }
  }

  const nextState = {
    ...state,
    users: updatedUsers,
    walletTransactions: [...newTxns, ...walletTxns],
    giftCatalog: getCatalog(state),
    giftPurchases: [purchase, ...(Array.isArray(state.giftPurchases) ? state.giftPurchases : [])],
    giftFulfillmentTasks: [fulfillmentTask, ...(Array.isArray(state.giftFulfillmentTasks) ? state.giftFulfillmentTasks : [])],
    notifications: [...newNotifications, ...notifications],
  };

  await replaceStateAndSeed(nextState);
  return { ok: true, purchase, fulfillmentTask };
}

export async function updateFulfillmentTaskStatus(taskId, status, userId) {
  const state = getState();
  const tasks = Array.isArray(state.giftFulfillmentTasks) ? state.giftFulfillmentTasks : [];
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return { ok: false, error: "Task not found." };

  const task = tasks[idx];
  const updatedTasks = [...tasks];
  updatedTasks[idx] = { ...task, status, updatedAt: new Date().toISOString(), updatedBy: userId };

  await replaceStateAndSeed({ ...state, giftFulfillmentTasks: updatedTasks });
  return { ok: true, task: updatedTasks[idx] };
}

export function getFulfillmentTasks({ sellerId, barId, isAdmin }) {
  const state = getState();
  const tasks = Array.isArray(state.giftFulfillmentTasks) ? state.giftFulfillmentTasks : [];
  if (isAdmin) return tasks;
  return tasks.filter((t) => {
    if (sellerId && t.sellerId === sellerId) return true;
    if (barId && t.barId === barId) return true;
    return false;
  });
}
