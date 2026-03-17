import cors from "cors";
import express from "express";
import morgan from "morgan";
import apiRoutes from "./routes/apiRoutes.js";
import { env } from "./config/env.js";
import { apiRateLimit, helmetMiddleware } from "./middlewares/security.js";

const app = express();
const allowedOrigins = env.clientOrigin
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function createCorsBlockedError(origin) {
  const error = new Error(`CORS blocked for origin: ${origin}`);
  error.status = 403;
  error.code = "CORS_ORIGIN_DENIED";
  return error;
}

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser requests (curl/health checks) without an Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(createCorsBlockedError(origin));
    },
    credentials: true
  })
);
app.use(helmetMiddleware);
app.use(apiRateLimit);
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

app.get("/", (_req, res) => {
  res.json({
    name: "Thailand Panties Service",
    status: "ok",
    health: "/api/health"
  });
});

app.use("/api", apiRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.code === "CORS_ORIGIN_DENIED") {
    return res.status(403).json({ error: "CORS origin denied" });
  }
  const status = Number(err?.status || 500);
  return res.status(status).json({ error: status >= 500 ? "Internal server error" : String(err?.message || "Request failed") });
});

export default app;
 