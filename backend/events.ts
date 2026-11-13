import { enrichEvents } from "./event-details.js";
import { createHash } from "node:crypto";
import { z } from "zod";

export class ServiceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const searchSchema = z.object({
  preferences: z.string().trim().min(1).max(2000),
  location: z.string().trim().min(1).max(200),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timeZone: z.string().refine(zone => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } }).optional(),
});
export type Search = z.infer<typeof searchSchema>;
export interface Event {
  id: string; title: string; date: string; type: string;
  price: number | null; players: number | null; capacity: number | null;
  store: string; distance: string; location: string; url: string;
  description?: string; rewards?: string; startsAt?: string; address?: string;
  detailsStatus?: "loaded" | "unavailable"; availability?: "open" | "full" | "waitlist";
  calendarStatus?: "free" | "conflict" | "unknown";
}
const scrapedSchema = z.object({ data: z.array(z.object({
  results: z.array(z.object({
    text: z.string(),
    attributes: z.array(z.object({ name: z.string(), value: z.string() })),
  })),
})) });

// Convert the existing scraper's event text into cards, keeping missing prices unknown.
export function parseEvents(input: unknown): Event[] {
  const parsed = scrapedSchema.safeParse(input);
  if (!parsed.success || !parsed.data.data[0]) throw new ServiceError(502, "Unexpected scraper response.");
  const events = new Map<string, Event>();
  for (const row of parsed.data.data[0].results) {
    const href = row.attributes.find(a => a.name === "href")?.value;
    if (!href) continue;
    let url: URL;
    try { url = new URL(href, "https://playriftbound.com"); } catch { continue; }
    if (url.origin !== "https://playriftbound.com" || !/^\/en-US\/events\/[^/]+/.test(url.pathname)) continue;
    const lines = row.text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length < 5) continue;
    const priceText = lines[5] ?? "";
    const priceMatch = priceText.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    const seats = lines.find(s => /^\d+\s*\/\s*\d+$/.test(s))?.split("/").map(Number);
    const venue = lines.slice(7).find(s => s.includes(" • "))?.split(" • ") ?? [];
    const id = createHash("sha256").update(url.href).digest("hex").slice(0, 24);
    events.set(id, {
      id, title: lines[3]!, date: lines.slice(0, 3).join(" "), type: lines[4]!,
      price: priceMatch ? Number(priceMatch[1]!.replaceAll(",", "")) : /^free$/i.test(priceText) ? 0 : null,
      players: seats?.[0] ?? null, capacity: seats?.[1] ?? null,
      availability: lines.some(s => /^full$/i.test(s)) ? "full" : lines.some(s => /^waitlist$/i.test(s)) ? "waitlist" : "open",
      store: venue[0] ?? "", distance: venue[1] ?? "", location: venue[2] ?? "", url: url.href,
    });
  }
  if (parsed.data.data[0].results.length && !events.size) {
    throw new ServiceError(502, "Event page format changed; no cards could be parsed.");
  }
  return [...events.values()].slice(0, 100);
}

// Fetch events near the user's selected coordinates using the existing Browserless service.
export async function scrapeEvents(search: Search, fetcher: typeof fetch = fetch): Promise<Event[]> {
  if (!process.env.BROWSERLESS_TOKEN) throw new ServiceError(503, "Set BROWSERLESS_TOKEN in .env to fetch events.");
  const url = new URL("https://playriftbound.com/en-US/events");
  url.search = new URLSearchParams({
    q: search.location, lat: String(search.latitude), lng: String(search.longitude), types: "NEXUS_NIGHT",
  }).toString();
  const response = await fetcher(
    "https://production-sfo.browserless.io/scrape?token=" + encodeURIComponent(process.env.BROWSERLESS_TOKEN),
    { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ url: url.href, elements: [{ selector: 'a[href^="/en-US/events/"]:not([href="/en-US/events/"])' }] }) });
  if (!response.ok) throw new ServiceError(response.status === 429 ? 429 : 502, "Event scraper unavailable. Check your Browserless token or try later.");
  return enrichEvents(parseEvents(await response.json()), search.timeZone || "America/Vancouver", fetcher);
}


