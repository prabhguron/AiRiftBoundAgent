import type { Event, Search } from "./events.js";

// Apply clear price/date limits before asking the model to rank events.
export function filterCandidates(search: Search, events: Event[], now = new Date()): Event[] {
  const preferences = search.preferences;
  const zone = search.timeZone || "America/Vancouver";
  const date = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(value);
  const budget = preferences.match(/\b(under|less than|below|at most|up to)\s*\$\s*(\d+(?:\.\d+)?)/i);
  const nextWeek = /\bnext week\b/i.test(preferences);
  const today = new Date(date(now) + "T00:00:00Z");
  const untilMonday = 8 - (today.getUTCDay() || 7);
  const monday = new Date(today.getTime() + untilMonday * 86400000).toISOString().slice(0, 10);
  const nextMonday = new Date(today.getTime() + (untilMonday + 7) * 86400000).toISOString().slice(0, 10);
  return events.filter(event => {
    if (event.availability === "full" || event.availability === "waitlist" ||
        (event.capacity !== null && event.players !== null && event.players >= event.capacity)) return false;
    if (budget) {
      if (event.price === null) return false;
      const inclusive = /at most|up to/i.test(budget[1]!);
      if (inclusive ? event.price > Number(budget[2]) : event.price >= Number(budget[2])) return false;
    }
    if (event.startsAt && Date.parse(event.startsAt) < now.getTime()) return false;
    if (nextWeek) {
      if (!event.startsAt) return false;
      const day = date(new Date(event.startsAt));
      if (day < monday || day >= nextMonday) return false;
    }
    return true;
  });
}

