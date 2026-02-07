import express from "express";

export function makeHttpApp() {
  const app = express();

  // ---- CORS (dev-safe) ----
  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;

    // allow localhost dev + your WSL forwarded hostnames (keep it permissive for now)
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    } else {
      // non-browser clients
      res.setHeader("Access-Control-Allow-Origin", "*");
    }

    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    // preflight
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    next();
  });

  // body
  app.use(express.json({ limit: "1mb" }));

  return app;
}
