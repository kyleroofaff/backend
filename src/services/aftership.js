import { env } from "../config/env.js";

const BASE_URL = "https://api.aftership.com/tracking/2026-01";

function headers() {
  return {
    "as-api-key": env.aftershipApiKey,
    "Content-Type": "application/json",
  };
}

function mapError(status, body) {
  const meta = body?.meta || {};
  const code = meta.code || status;
  const message = meta.message || "Unknown AfterShip error";

  if (code === 401 || status === 401) {
    return { ok: false, code: 401, error: "Invalid AfterShip API key." };
  }
  if (code === 404 || status === 404) {
    return { ok: false, code: 404, error: "Tracking not found." };
  }
  if (code === 429 || status === 429) {
    return { ok: false, code: 429, error: "AfterShip rate limit hit. Try again shortly." };
  }
  return { ok: false, code, error: message };
}

/**
 * Register a new tracking number with AfterShip.
 * @param {string} trackingNumber
 * @param {string} [slug] - Carrier code (e.g. "usps", "fedex"). Omit for auto-detect.
 */
export async function createTracking(trackingNumber, slug) {
  if (!env.aftershipApiKey) {
    return { ok: false, code: 500, error: "AfterShip API key not configured." };
  }

  const tracking = { tracking_number: trackingNumber };
  if (slug) tracking.slug = slug;

  try {
    const res = await fetch(`${BASE_URL}/trackings`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ tracking }),
    });

    const body = await res.json();
    if (!res.ok) return mapError(res.status, body);

    return { ok: true, tracking: body.data?.tracking || body.data || {} };
  } catch (err) {
    return { ok: false, code: 500, error: `AfterShip request failed: ${err.message}` };
  }
}

/**
 * Retrieve the current tracking status from AfterShip.
 * @param {string} id - AfterShip tracking ID
 */
export async function getTracking(id) {
  if (!env.aftershipApiKey) {
    return { ok: false, code: 500, error: "AfterShip API key not configured." };
  }

  try {
    const res = await fetch(`${BASE_URL}/trackings/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: headers(),
    });

    const body = await res.json();
    if (!res.ok) return mapError(res.status, body);

    const t = body.data?.tracking || body.data || {};
    return {
      ok: true,
      tracking: {
        id: t.id,
        trackingNumber: t.tracking_number,
        slug: t.slug,
        tag: t.tag,
        subtag: t.subtag,
        checkpoints: t.checkpoints || [],
        trackingUrl: t.aftership_tracking_url || "",
        estimatedDeliveryDate: t.estimated_delivery_date?.datetime || t.estimated_delivery_date || null,
      },
    };
  } catch (err) {
    return { ok: false, code: 500, error: `AfterShip request failed: ${err.message}` };
  }
}

/**
 * Delete a tracking from AfterShip.
 * @param {string} id - AfterShip tracking ID
 */
export async function deleteTracking(id) {
  if (!env.aftershipApiKey) {
    return { ok: false, code: 500, error: "AfterShip API key not configured." };
  }

  try {
    const res = await fetch(`${BASE_URL}/trackings/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: headers(),
    });

    if (res.status === 204 || res.status === 200) {
      return { ok: true };
    }

    const body = await res.json().catch(() => ({}));
    return mapError(res.status, body);
  } catch (err) {
    return { ok: false, code: 500, error: `AfterShip request failed: ${err.message}` };
  }
}
