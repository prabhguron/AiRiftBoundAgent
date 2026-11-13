import type { Event } from "./events.js";

export interface EventDetails { description: string; startsAt: string; address: string }
const cache = new Map<string, { expires: number; details: EventDetails }>();

// Read the event's server-rendered data without executing scripts or using Riot login.
export function parseEventDetails(html: string): EventDetails | null {
  let stream = "";
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const script = match[1]!.trim();
    const prefix = "self.__next_f.push(";
    if (!script.startsWith(prefix)) continue;
    try {
      const entry = JSON.parse(script.slice(prefix.length).replace(/\);?$/, ""));
      if (entry[0] === 1 && typeof entry[1] === "string") stream += entry[1];
    } catch { /* Ignore unrelated or changed script formats. */ }
  }
  function visit(value: unknown): EventDetails | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (typeof item.description === "string" && typeof item.date === "string" &&
        typeof item.address === "string" && Number.isFinite(Date.parse(item.date)) &&
        !/^\$[a-z\d]+$/i.test(item.description)) {
      return { description: item.description, startsAt: item.date, address: item.address };
    }
    for (const child of Object.values(item)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  }
  for (const line of stream.split("\n")) {
    try {
      const found = visit(JSON.parse(line.slice(line.indexOf(":") + 1)));
      if (found) return found;
    } catch { /* Not every React stream record contains JSON. */ }
  }
  return null;
}

// Preserve published prize conditions together with the reward text.
export function rewardDetails(description: string): string {
  return description.split(/\n\s*\n/).filter(paragraph =>
    /reward|priz|promo|booster|\bpack\b|\bpacks\b|store credit|payout|\bwin\b/i.test(paragraph),
  ).join("\n\n");
}

// Fetch every listed event's details, with four workers and a short cache.
export async function enrichEvents(events: Event[], timeZone: string, fetcher: typeof fetch = fetch): Promise<Event[]> {
  const result = [...events];
  let cursor = 0;
  async function worker() {
    while (cursor < events.length) {
      const index = cursor++;
      const event = events[index]!;
      try {
        const url = new URL(event.url);
        if (url.origin !== "https://playriftbound.com" || !/^\/en-US\/events\/[^/]+/.test(url.pathname)) throw new Error("Invalid event URL");
        let details = fetcher === fetch ? cache.get(event.url) : undefined;
        if (!details || details.expires <= Date.now()) {
          const response = await fetcher(event.url, { signal: AbortSignal.timeout(15000), redirect: "error" });
          if (!response.ok) throw new Error("Event details unavailable");
          const parsed = parseEventDetails(await response.text());
          if (!parsed) throw new Error("Event details format changed");
          details = { details: parsed, expires: Date.now() + 5 * 60 * 1000 };
          if (fetcher === fetch) {
            if (cache.size >= 500) cache.delete(cache.keys().next().value!);
            cache.set(event.url, details);
          }
        }
        const source = details.details;
        result[index] = {
          ...event, description: source.description, rewards: rewardDetails(source.description),
          startsAt: source.startsAt, detailsStatus: "loaded", address: source.address,
          date: new Intl.DateTimeFormat("en-CA", {
            timeZone, month: "short", day: "numeric", year: "numeric", weekday: "long",
            hour: "numeric", minute: "2-digit", timeZoneName: "short",
          }).format(new Date(source.startsAt)),
        };
      } catch {
        result[index] = { ...event, description: "", rewards: "", detailsStatus: "unavailable" };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, events.length) }, worker));
  return result;
}

