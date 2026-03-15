import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

export const helmetMiddleware = helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
});

export const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});

export const strictAuthRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false
});

export function rejectUnknownBodyKeys(allowedKeys) {
  const allow = new Set(allowedKeys);
  return (req, res, next) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return next();
    const unknown = Object.keys(body).filter((key) => !allow.has(key));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown request fields: ${unknown.join(", ")}` });
    }
    return next();
  };
}
