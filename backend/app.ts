import { searchCities } from "./cities.js";
import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { searchSchema, scrapeEvents, ServiceError } from "./events.js";
import { recommend, type Card } from "./recommend.js";

interface Dependencies {
  cities?: typeof searchCities;
  scrape: typeof scrapeEvents;
  recommend: typeof recommend;
  log: (message: string) => void;
}

// Create the API with replaceable services so tests never require real API keys.
export function createApp(deps: Dependencies = { scrape: scrapeEvents, recommend, log: console.log }) {
  const app = express();
  const batches = new Map<string, { expires: number; cards: Card[]; approved: Set<string> }>();
  let activeSearches = 0;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/cities", async (req, res) => {
    if (typeof req.query.q !== "string" || req.query.q.trim().length < 2 || req.query.q.length > 100) {
      throw new ServiceError(400, "Enter a city name.");
    }
    res.json({ cities: await (deps.cities ?? searchCities)(req.query.q) });
  });
  app.post("/api/recommendations", async (req, res) => {
    const input = searchSchema.safeParse(req.body);
    if (!input.success) throw new ServiceError(400, "Select a city and enter your preferences.");
    if (activeSearches >= 3) throw new ServiceError(429, "Too many searches running. Please try again shortly.");
    activeSearches++;
    try {
      const events = await deps.scrape(input.data);
      const cards = await deps.recommend(input.data, events);
      for (const [id, batch] of batches) if (batch.expires <= Date.now()) batches.delete(id);
      if (batches.size >= 500) batches.delete(batches.keys().next().value!);
      const requestId = randomUUID();
      batches.set(requestId, { expires: Date.now() + 30 * 60 * 1000, cards, approved: new Set() });
      const message = cards.length ? cards.length + (cards.length === 1 ? " event found" : " events found")
        : "No matching events. Try another city or different preferences.";
      res.json({ requestId, cards, message });
    } finally { activeSearches--; }
  });
  app.post("/api/approvals", (req, res) => {
    const { requestId, eventId } = req.body ?? {};
    if (typeof requestId !== "string" || typeof eventId !== "string") throw new ServiceError(400, "Provide requestId and eventId.");
    const batch = batches.get(requestId);
    if (!batch || batch.expires <= Date.now()) {
      batches.delete(requestId);
      throw new ServiceError(404, "Recommendations expired or missing. Search again.");
    }
    if (!batch.cards.some(c => c.id === eventId)) throw new ServiceError(404, "Event was not in these recommendations.");
    if (!batch.approved.has(eventId)) {
      // Replace this log with the teammate's registration handoff later.
      deps.log("approval");
      batch.approved.add(eventId);
    }
    res.json({ status: "approved", eventId, message: "Approved." });
  });
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ServiceError) { res.status(error.status).json({ error: error.message }); return; }
    if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
      res.status(400).json({ error: "Invalid or oversized JSON request." }); return;
    }
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      res.status(504).json({ error: "The external service timed out. Please try again." }); return;
    }
    res.status(502).json({ error: "Unable to contact an external service. Please try again." });
  };
  app.use(errors);
  return app;
}



