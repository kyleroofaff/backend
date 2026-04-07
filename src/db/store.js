import { seedData } from "./seedData.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

let dbState = structuredClone(seedData);
const dbDir = path.dirname(fileURLToPath(import.meta.url));
const seedDataFilePath = path.join(dbDir, "seedData.js");

export function getState() {
  return dbState;
}

export function upsertUserInState(user) {
  if (!user || !user.id) return;
  const users = Array.isArray(dbState.users) ? [...dbState.users] : [];
  const idx = users.findIndex((u) => u.id === user.id);
  if (idx >= 0) {
    users[idx] = { ...users[idx], ...user };
  } else {
    users.push(user);
  }
  dbState = { ...dbState, users };
}

export function bulkReplaceUsersInState(pgUsers) {
  if (!Array.isArray(pgUsers)) return;
  const stateUsers = Array.isArray(dbState.users) ? dbState.users : [];
  const stateById = new Map(stateUsers.map((u) => [u.id, u]));
  const merged = [];
  const seen = new Set();
  for (const pgUser of pgUsers) {
    if (!pgUser?.id) continue;
    seen.add(pgUser.id);
    const existing = stateById.get(pgUser.id);
    merged.push(existing ? { ...existing, ...pgUser } : pgUser);
  }
  for (const stateUser of stateUsers) {
    if (stateUser?.id && !seen.has(stateUser.id)) {
      merged.push(stateUser);
    }
  }
  dbState = { ...dbState, users: merged };

  syncSellerNamesFromUsers(merged);
}

export function resetState() {
  dbState = structuredClone(seedData);
  return dbState;
}

function syncSellerNamesFromUsers(users) {
  const sellers = Array.isArray(dbState.sellers) ? dbState.sellers : [];
  const userById = new Map(users.filter((u) => u?.id).map((u) => [u.id, u]));
  let changed = false;
  const updated = sellers.map((seller) => {
    const matchByUserId = users.find(
      (u) => u.role === "seller" && u.sellerId === seller.id
    );
    if (matchByUserId && matchByUserId.name && matchByUserId.name !== seller.name) {
      changed = true;
      return { ...seller, name: matchByUserId.name };
    }
    return seller;
  });
  if (changed) {
    dbState = { ...dbState, sellers: updated };
  }

  scaffoldMissingSellers(users);
}

function scaffoldMissingSellers(users) {
  const sellers = Array.isArray(dbState.sellers) ? dbState.sellers : [];
  const sellerIdSet = new Set(sellers.map((s) => s.id));
  const missing = users.filter(
    (u) => u.role === "seller" && u.sellerId && !sellerIdSet.has(u.sellerId)
  );
  if (missing.length === 0) return;

  const newSellers = missing.map((u) => {
    const profile = u.profile && typeof u.profile === "object" ? u.profile : {};
    return {
      id: u.sellerId,
      name: u.name || "",
      location: [profile.city || u.city || "", profile.country || u.country || ""].filter(Boolean).join(", "),
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
      height: profile.heightCm || u.heightCm || "",
      weight: profile.weightKg || u.weightKg || "",
      hairColor: profile.hairColor || u.hairColor || "",
      braSize: profile.braSize || u.braSize || "",
      pantySize: profile.pantySize || u.pantySize || "",
    };
  });
  console.log(`[store] Scaffolded ${newSellers.length} missing seller record(s):`, newSellers.map((s) => s.id).join(", "));
  const nextSellers = [...sellers, ...newSellers];
  dbState = { ...dbState, sellers: nextSellers };
  writeSeedData({ ...seedData, sellers: nextSellers }).catch((err) =>
    console.error("[store] Failed to persist scaffolded sellers:", err.message)
  );
}

export function ensureSellerInState(user) {
  if (!user || user.role !== "seller" || !user.sellerId) return false;
  const sellers = Array.isArray(dbState.sellers) ? dbState.sellers : [];
  if (sellers.some((s) => s.id === user.sellerId)) return true;
  scaffoldMissingSellers([user]);
  return dbState.sellers.some((s) => s.id === user.sellerId);
}

export function replaceState(nextState) {
  if (!nextState || typeof nextState !== "object") {
    return dbState;
  }
  dbState = nextState;
  return dbState;
}

export async function replaceStateAndSeed(nextState) {
  if (!nextState || typeof nextState !== "object") {
    return dbState;
  }
  await writeSeedData(nextState);
  dbState = nextState;
  Object.assign(seedData, nextState);
  return dbState;
}

export function getSellerPostsState() {
  return dbState.sellerPosts || [];
}

export function getPostReportsState() {
  return dbState.postReports || [];
}

function serializeSeedData(nextSeedData) {
  return `export const seedData = ${JSON.stringify(nextSeedData, null, 2)};\n`;
}

async function writeSeedData(nextSeedData) {
  await fs.writeFile(seedDataFilePath, serializeSeedData(nextSeedData), "utf8");
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

export async function deleteProductFromStateAndSeed({ productId, productTitle, sellerId }) {
  if (!productId && !productTitle) {
    return { ok: false, reason: "invalid" };
  }

  const normalizedTitle = normalizeText(productTitle);
  const existingProduct = (dbState.products || []).find((product) => {
    if (productId && product.id === productId) return true;
    if (normalizedTitle && normalizeText(product.title) === normalizedTitle) return true;
    return false;
  });
  if (!existingProduct) {
    return { ok: false, reason: "not_found" };
  }
  if (sellerId && existingProduct.sellerId !== sellerId) {
    return { ok: false, reason: "forbidden" };
  }

  const deleteProductId = existingProduct.id;
  const nextDbState = {
    ...dbState,
    products: (dbState.products || []).filter((product) => product.id !== deleteProductId)
  };
  const nextSeedData = {
    ...seedData,
    products: (seedData.products || []).filter((product) => product.id !== deleteProductId)
  };

  await writeSeedData(nextSeedData);

  dbState = nextDbState;
  Object.assign(seedData, nextSeedData);
  return { ok: true, product: existingProduct, deletedProductId: deleteProductId, state: dbState };
}

export async function createSellerPostInStateAndSeed(post) {
  if (!post || typeof post !== "object" || !post.id || !post.sellerId || !post.image) {
    return { ok: false, reason: "invalid" };
  }

  const nextDbState = {
    ...dbState,
    sellerPosts: [post, ...(dbState.sellerPosts || [])]
  };
  const nextSeedData = {
    ...seedData,
    sellerPosts: [post, ...(seedData.sellerPosts || [])]
  };

  await writeSeedData(nextSeedData);

  dbState = nextDbState;
  Object.assign(seedData, nextSeedData);
  return { ok: true, post, state: dbState };
}

export async function deleteSellerPostFromStateAndSeed({ postId, sellerId, isAdmin }) {
  if (!postId) {
    return { ok: false, reason: "invalid" };
  }

  const existingPost = (dbState.sellerPosts || []).find((post) => post.id === postId);
  if (!existingPost) {
    return { ok: false, reason: "not_found" };
  }

  if (!isAdmin && !sellerId) {
    return { ok: false, reason: "forbidden" };
  }
  if (!isAdmin && sellerId && existingPost.sellerId !== sellerId) {
    return { ok: false, reason: "forbidden" };
  }

  const nextDbState = {
    ...dbState,
    sellerPosts: (dbState.sellerPosts || []).filter((post) => post.id !== postId)
  };
  const nextSeedData = {
    ...seedData,
    sellerPosts: (seedData.sellerPosts || []).filter((post) => post.id !== postId)
  };

  await writeSeedData(nextSeedData);

  dbState = nextDbState;
  Object.assign(seedData, nextSeedData);
  return { ok: true, deletedPostId: postId, post: existingPost, state: dbState };
}

export async function createPostReportInStateAndSeed(report) {
  if (!report || typeof report !== "object" || !report.id || !report.postId || !report.reporterUserId) {
    return { ok: false, reason: "invalid" };
  }

  const nextDbState = {
    ...dbState,
    postReports: [report, ...(dbState.postReports || [])]
  };
  const nextSeedData = {
    ...seedData,
    postReports: [report, ...(seedData.postReports || [])]
  };

  await writeSeedData(nextSeedData);

  dbState = nextDbState;
  Object.assign(seedData, nextSeedData);
  return { ok: true, report, state: dbState };
}

export async function resolvePostReportInStateAndSeed({ reportId, resolvedByUserId }) {
  if (!reportId) {
    return { ok: false, reason: "invalid" };
  }

  const existingReport = (dbState.postReports || []).find((report) => report.id === reportId);
  if (!existingReport) {
    return { ok: false, reason: "not_found" };
  }

  const resolvedAt = new Date().toISOString();
  const nextDbState = {
    ...dbState,
    postReports: (dbState.postReports || []).map((report) => (
      report.id === reportId
        ? { ...report, status: "resolved", resolvedAt, resolvedByUserId: resolvedByUserId || null }
        : report
    ))
  };
  const nextSeedData = {
    ...seedData,
    postReports: (seedData.postReports || []).map((report) => (
      report.id === reportId
        ? { ...report, status: "resolved", resolvedAt, resolvedByUserId: resolvedByUserId || null }
        : report
    ))
  };

  await writeSeedData(nextSeedData);

  dbState = nextDbState;
  Object.assign(seedData, nextSeedData);
  return { ok: true, reportId, state: dbState };
}
