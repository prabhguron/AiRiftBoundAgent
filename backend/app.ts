import { searchCities } from "./cities.js";
import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { calendarFromEnv, checkRange, eventHours, eventWindow, markConflicts, type CalendarService } from "./calendar.js";
import { searchSchema, scrapeEvents, ServiceError, type Event } from "./events.js";
import { recommend, type Card } from "./recommend.js";

interface Dependencies {
  cities?: typeof searchCities;
  scrape: typeof scrapeEvents;
  recommend: typeof recommend;
  log: (message: string) => void;
  calendar?: CalendarService;
}

// Create the API with replaceable services so tests never require real API keys.
export function createApp(deps: Dependencies = { scrape: scrapeEvents, recommend, log: console.log, calendar: calendarFromEnv() }) {
  const app = express();
  const batches = new Map<string, { expires: number; cards: Card[]; approved: Set<string> }>();
  const approving = new Set<string>();
  const calendar = deps.calendar;
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

  // Google Calendar connection. The browser is sent to Google and comes back to the callback.
  app.get("/api/calendar", async (_req, res) => {
    res.json({ configured: !!calendar?.configured, connected: !!calendar && await calendar.isConnected() });
  });
  app.get("/api/calendar/connect", (_req, res) => {
    if (!calendar) throw new ServiceError(503, "Google Calendar is not set up on this server.");
    res.redirect(calendar.authUrl());
  });
  app.get("/api/calendar/callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (!calendar || typeof state !== "string" || typeof code !== "string" || error) {
      res.redirect("/?calendar=" + (error === "access_denied" ? "denied" : "failed")); return;
    }
    try {
      await calendar.finishAuth(code, state);
      res.redirect("/?calendar=connected");
    } catch (failure) {
      res.redirect("/?calendar=" + (failure instanceof ServiceError && failure.status === 403 ? "missing-scope" : "failed"));
    }
  });
  app.post("/api/calendar/disconnect", async (_req, res) => {
    await calendar?.disconnect();
    res.json({ connected: false });
  });

  // Drop events that clash with the user's calendar. A calendar failure never blocks the search;
  // the cards are marked "unknown" and approval checks again before anything is added.
  async function applyCalendar(events: Event[]): Promise<{ events: Event[]; note: string }> {
    if (!calendar || !await calendar.isConnected()) return { events, note: "" };
    const hours = eventHours();
    const range = checkRange(events, hours);
    try {
      const busy = range ? await calendar.busy(new Date(range.start), new Date(range.end)) : [];
      const marked = markConflicts(events, busy, range ?? { start: 0, end: 0 }, hours);
      const kept = marked.filter(e => e.calendarStatus !== "conflict");
      const skipped = marked.length - kept.length;
      return { events: kept, note: skipped ? ` ${skipped} skipped because they clash with your calendar.` : "" };
    } catch (error) {
      const message = error instanceof ServiceError && error.status === 401 ? error.message : "Couldn't check your calendar this time.";
      return { events: events.map(e => ({ ...e, calendarStatus: "unknown" as const })), note: " " + message };
    }
  }

  app.post("/api/recommendations", async (req, res) => {
    const input = searchSchema.safeParse(req.body);
    if (!input.success) throw new ServiceError(400, "Select a city and enter your preferences.");
    if (activeSearches >= 3) throw new ServiceError(429, "Too many searches running. Please try again shortly.");
    activeSearches++;
    try {
      const scraped = await deps.scrape(input.data);
      const { events, note } = await applyCalendar(scraped);
      const cards = await deps.recommend(input.data, events);
      for (const [id, batch] of batches) if (batch.expires <= Date.now()) batches.delete(id);
      if (batches.size >= 500) batches.delete(batches.keys().next().value!);
      const requestId = randomUUID();
      batches.set(requestId, { expires: Date.now() + 30 * 60 * 1000, cards, approved: new Set() });
      const message = (cards.length ? cards.length + (cards.length === 1 ? " event found." : " events found.")
        : "No matching events. Try another city or different preferences.") + note;
      res.json({ requestId, cards, message });
    } finally { activeSearches--; }
  });

  app.post("/api/approvals", async (req, res) => {
    const { requestId, eventId } = req.body ?? {};
    if (typeof requestId !== "string" || typeof eventId !== "string") throw new ServiceError(400, "Provide requestId and eventId.");
    const batch = batches.get(requestId);
    if (!batch || batch.expires <= Date.now()) {
      batches.delete(requestId);
      throw new ServiceError(404, "Recommendations expired or missing. Search again.");
    }
    const card = batch.cards.find(c => c.id === eventId);
    if (!card) throw new ServiceError(404, "Event was not in these recommendations.");
    if (batch.approved.has(eventId)) { res.json({ status: "approved", eventId, message: "Already approved." }); return; }
    if (approving.has(eventId)) throw new ServiceError(409, "This event is already being approved.");
    approving.add(eventId);
    try {
      let message = "Approved.";
      if (calendar && await calendar.isConnected()) {
        // Check again at approval time: the calendar may have changed since the search.
        const hours = eventHours();
        const window = eventWindow(card, hours);
        if (!window) throw new ServiceError(409, "This event has no published start time, so it can't be checked against your calendar.");
        if (await calendar.findEvent(card.id)) {
          message = "Approved. It's already on your Google Calendar.";
        } else {
          const busy = await calendar.busy(new Date(window.start), new Date(window.end));
          if (busy.length) throw new ServiceError(409, "Not approved: this event clashes with something on your calendar.");
          await calendar.addEvent(card, hours);
          message = "Approved and added to your Google Calendar.";
        }
      }
      // Replace this log with the teammate's registration handoff later.
      deps.log("approval");
      batch.approved.add(eventId);
      res.json({ status: "approved", eventId, message });
    } finally { approving.delete(eventId); }
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
