import { z } from "zod";
import { ServiceError } from "./events.js";

const citySchema = z.object({
  id: z.number(), name: z.string(), admin1: z.string().optional(), country: z.string(),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  timezone: z.string().refine(zone => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } }),
  feature_code: z.string(),
});
export interface City { id: number; label: string; latitude: number; longitude: number; timeZone: string }
const cache = new Map<string, { expires: number; cities: City[] }>();

// Find cities with coordinates and time zones for the location dropdown.
export async function searchCities(query: string, fetcher: typeof fetch = fetch): Promise<City[]> {
  const term = query.trim();
  if (term.length < 2 || term.length > 100) return [];
  const key = term.toLowerCase();
  const saved = fetcher === fetch ? cache.get(key) : undefined;
  if (saved && saved.expires > Date.now()) return saved.cities;
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name: term, count: "10", language: "en", format: "json" }).toString();
  const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new ServiceError(503, "City search is unavailable. Please try again.");
  const body = z.object({ results: z.array(z.unknown()).optional() }).safeParse(await response.json());
  if (!body.success) throw new ServiceError(502, "City search is unavailable. Please try again.");
  const cities: City[] = [];
  for (const row of body.data.results ?? []) {
    const parsed = citySchema.safeParse(row);
    if (!parsed.success || !parsed.data.feature_code.startsWith("PPL")) continue;
    const city = parsed.data;
    cities.push({ id: city.id, label: [...new Set([city.name, city.admin1, city.country].filter(Boolean))].join(", "),
      latitude: city.latitude, longitude: city.longitude, timeZone: city.timezone });
  }
  if (fetcher === fetch) {
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 60 * 60 * 1000, cities });
  }
  return cities;
}

