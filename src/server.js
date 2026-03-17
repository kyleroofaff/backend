import app from "./app.js";
import { env } from "./config/env.js";

if (env.nodeEnv === "production" && !env.jwtSecret) {
  throw new Error("JWT_SECRET must be set in production.");
}

app.listen(env.port, () => {
  console.log(`API running at http://localhost:${env.port}`);
});
