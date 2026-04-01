import { getState, replaceStateAndSeed } from "../db/store.js";
import { createTracking, getTracking, deleteTracking } from "../services/aftership.js";

function findOrder(state, orderId) {
  return (state.orders || []).find((o) => o.id === orderId) || null;
}

function isAdminUser(user) {
  return user?.role === "admin" || user?.isSuperAdmin === true || user?.hasAdminAccess === true;
}

function isBarLinkedToOrder(user, order, state) {
  if (user?.role !== "bar" || !user.barId) return false;
  const bar = (state.bars || []).find((b) => b.id === user.barId);
  if (!bar) return false;
  const affiliatedSellerIds = new Set(
    (bar.affiliatedSellers || []).map((s) => (typeof s === "string" ? s : s.id))
  );
  const sellers = state.sellers || [];
  for (const s of sellers) {
    if (s.affiliatedBarId === user.barId) affiliatedSellerIds.add(s.id);
  }
  const products = state.products || [];
  const orderItems = order.items || [];
  for (const itemId of orderItems) {
    const product = products.find((p) => p.id === itemId);
    if (product && affiliatedSellerIds.has(product.sellerId)) return true;
  }
  return orderItems.length > 0 && affiliatedSellerIds.size > 0;
}

function isBuyerOfOrder(user, order) {
  if (!user) return false;
  if (order.buyerUserId && user.id === order.buyerUserId) return true;
  if (!order.buyerUserId && order.buyerEmail && user.email === order.buyerEmail) return true;
  return false;
}

const SLUG_BY_CARRIER = {
  "Thailand Post": "thailand-post",
  "Kerry Express": "kerry-express",
  "Flash Express": "flash-express",
  "DHL": "dhl",
  "FedEx": "fedex",
  "UPS": "ups",
  "USPS": "usps",
  "EMS": "ems",
  "J&T Express": "j-t-express-th",
};

export async function addOrderTracking(req, res, next) {
  try {
    const user = req.auth?.user;
    if (!user) return res.status(401).json({ error: "Authentication required." });

    const { orderId } = req.params;
    const { trackingNumber, slug } = req.body;

    if (!trackingNumber || typeof trackingNumber !== "string" || !trackingNumber.trim()) {
      return res.status(400).json({ error: "trackingNumber is required." });
    }

    const state = getState();
    const order = findOrder(state, orderId);
    if (!order) return res.status(404).json({ error: "Order not found." });

    const isAdmin = isAdminUser(user);
    const barLinked = isBarLinkedToOrder(user, order, state);
    if (!isAdmin && !barLinked) {
      return res.status(403).json({ error: "Only admin or the affiliated bar can add tracking." });
    }

    const carrierSlug = slug || SLUG_BY_CARRIER[order.trackingCarrier] || undefined;
    const result = await createTracking(trackingNumber.trim(), carrierSlug);

    if (!result.ok) {
      return res.status(result.code || 502).json({ error: result.error });
    }

    const aftershipId = result.tracking?.id || "";
    const now = new Date().toISOString();

    const nextState = {
      ...state,
      orders: (state.orders || []).map((o) =>
        o.id === orderId
          ? {
              ...o,
              trackingNumber: trackingNumber.trim(),
              trackingCarrier: order.trackingCarrier || (carrierSlug || ""),
              aftershipTrackingId: aftershipId,
              fulfillmentStatus: o.fulfillmentStatus === "processing" ? "shipped" : o.fulfillmentStatus,
              updatedAt: now,
            }
          : o
      ),
    };

    await replaceStateAndSeed(nextState);

    return res.json({
      ok: true,
      order: nextState.orders.find((o) => o.id === orderId),
      aftershipId,
    });
  } catch (err) {
    return next(err);
  }
}

export async function getOrderTracking(req, res, next) {
  try {
    const user = req.auth?.user;
    if (!user) return res.status(401).json({ error: "Authentication required." });

    const { orderId } = req.params;
    const state = getState();
    const order = findOrder(state, orderId);
    if (!order) return res.status(404).json({ error: "Order not found." });

    const isAdmin = isAdminUser(user);
    const buyer = isBuyerOfOrder(user, order);
    const barLinked = isBarLinkedToOrder(user, order, state);
    if (!isAdmin && !buyer && !barLinked) {
      return res.status(403).json({ error: "Not authorized to view this tracking." });
    }

    if (!order.aftershipTrackingId) {
      return res.json({
        ok: true,
        tracking: null,
        trackingNumber: order.trackingNumber || "",
        fulfillmentStatus: order.fulfillmentStatus || "processing",
      });
    }

    const result = await getTracking(order.aftershipTrackingId);
    if (!result.ok) {
      return res.status(result.code || 502).json({ error: result.error });
    }

    return res.json({
      ok: true,
      tracking: result.tracking,
      fulfillmentStatus: order.fulfillmentStatus || "processing",
    });
  } catch (err) {
    return next(err);
  }
}

export async function removeOrderTracking(req, res, next) {
  try {
    const user = req.auth?.user;
    if (!user) return res.status(401).json({ error: "Authentication required." });

    if (!isAdminUser(user)) {
      return res.status(403).json({ error: "Only admin can remove tracking." });
    }

    const { orderId } = req.params;
    const state = getState();
    const order = findOrder(state, orderId);
    if (!order) return res.status(404).json({ error: "Order not found." });

    if (order.aftershipTrackingId) {
      await deleteTracking(order.aftershipTrackingId);
    }

    const now = new Date().toISOString();
    const nextState = {
      ...state,
      orders: (state.orders || []).map((o) =>
        o.id === orderId
          ? {
              ...o,
              trackingNumber: "",
              trackingCarrier: "",
              aftershipTrackingId: "",
              updatedAt: now,
            }
          : o
      ),
    };

    await replaceStateAndSeed(nextState);

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}
