import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ServiceError, type Event } from "./events.js";

// Free/busy lets us see conflicts without reading event titles; events lets us add approved events.
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";
// Google rejects free/busy ranges that are too long, so later events are left as "unknown".
const MAX_RANGE_MS = 60 * 86400000;

export interface Busy { start: number; end: number }
export type CalendarStatus = "free" | "conflict" | "unknown";
export interface CalendarService {
  configured: boolean;
  isConnected(): Promise<boolean>;
  authUrl(): string;
  finishAuth(code: string, state: string): Promise<void>;
  disconnect(): Promise<void>;
  /** Busy blocks on the primary calendar between from and to. */
  busy(from: Date, to: Date): Promise<Busy[]>;
  /** True when this Riftbound event is already on the calendar. */
  findEvent(eventId: string): Promise<boolean>;
  addEvent(event: Event, hours: number): Promise<void>;
}

const tokenSchema = z.object({
  access_token: z.string(), refresh_token: z.string().optional(),
  expires_in: z.number(), scope: z.string().optional(),
});
interface Saved { accessToken: string; refreshToken: string; expiresAt: number }

// Event length is not published on listings, so assume a fixed block (default 3 hours).
export function eventHours(): number {
  const hours = Number(process.env.CALENDAR_EVENT_HOURS);
  return Number.isFinite(hours) && hours > 0 && hours <= 24 ? hours : 3;
}

export function eventWindow(event: Event, hours: number): Busy | null {
  const start = event.startsAt ? Date.parse(event.startsAt) : NaN;
  return Number.isFinite(start) ? { start, end: start + hours * 3600000 } : null;
}

// Mark each event free, conflicting, or unknown (no start time, or outside the checked range).
export function markConflicts(events: Event[], busy: Busy[], range: Busy, hours: number): Event[] {
  return events.map(event => {
    const window = eventWindow(event, hours);
    if (!window || window.start < range.start || window.end > range.end) return { ...event, calendarStatus: "unknown" };
    const clash = busy.some(block => block.start < window.end && block.end > window.start);
    return { ...event, calendarStatus: clash ? "conflict" : "free" };
  });
}

// The time span to ask Google about: every known event window, capped at MAX_RANGE_MS.
export function checkRange(events: Event[], hours: number, now = Date.now()): Busy | null {
  const windows = events.map(e => eventWindow(e, hours)).filter((w): w is Busy => !!w && w.end > now);
  if (!windows.length) return null;
  const start = Math.max(now, Math.min(...windows.map(w => w.start)));
  return { start, end: Math.min(start + MAX_RANGE_MS, Math.max(...windows.map(w => w.end))) };
}

// Google Calendar over plain REST calls. Tokens live in a local, gitignored file (single-user demo).
export function createGoogleCalendar(options: {
  clientId?: string; clientSecret?: string; redirectUri: string; tokenFile: string; fetcher?: typeof fetch;
}): CalendarService {
  const { clientId, clientSecret, redirectUri, tokenFile } = options;
  const fetcher = options.fetcher ?? fetch;
  const states = new Map<string, number>();
  let saved: Saved | null | undefined;

  async function load(): Promise<Saved | null> {
    if (saved !== undefined) return saved;
    try { saved = JSON.parse(await readFile(tokenFile, "utf8")) as Saved; } catch { saved = null; }
    return saved;
  }
  async function save(value: Saved | null) {
    saved = value;
    if (value) await writeFile(tokenFile, JSON.stringify(value), { mode: 0o600 });
    else await rm(tokenFile, { force: true });
  }
  async function tokenRequest(body: Record<string, string>) {
    const response = await fetcher(TOKEN_URL, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, ...body }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      if ((json as { error?: string }).error === "invalid_grant") {
        await save(null);
        throw new ServiceError(401, "Google Calendar access expired or was revoked. Connect it again.");
      }
      throw new ServiceError(502, "Google sign-in failed. Please try again.");
    }
    const parsed = tokenSchema.safeParse(json);
    if (!parsed.success) throw new ServiceError(502, "Unexpected response from Google sign-in.");
    return parsed.data;
  }
  async function accessToken(): Promise<string> {
    const current = await load();
    if (!current) throw new ServiceError(401, "Connect Google Calendar first.");
    if (current.expiresAt > Date.now() + 60000) return current.accessToken;
    const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: current.refreshToken });
    await save({ ...current, accessToken: fresh.access_token, expiresAt: Date.now() + fresh.expires_in * 1000 });
    return fresh.access_token;
  }
  async function api(path: string, init: RequestInit = {}) {
    const response = await fetcher(API + path, {
      ...init, signal: AbortSignal.timeout(10000),
      headers: { Authorization: "Bearer " + await accessToken(), "Content-Type": "application/json" },
    });
    if (response.status === 401) {
      await save(null);
      throw new ServiceError(401, "Google Calendar access expired or was revoked. Connect it again.");
    }
    if (!response.ok) throw new ServiceError(response.status === 429 ? 429 : 502, "Google Calendar request failed. Please try again.");
    return response.json();
  }

  return {
    configured: !!(clientId && clientSecret),
    async isConnected() { return !!(clientId && clientSecret) && !!await load(); },
    authUrl() {
      if (!clientId || !clientSecret) throw new ServiceError(503, "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env to connect Google Calendar.");
      for (const [key, expires] of states) if (expires <= Date.now()) states.delete(key);
      const state = randomBytes(24).toString("base64url");
      states.set(state, Date.now() + 10 * 60000);
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code", state,
        scope: CALENDAR_SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true",
      }).toString();
      return url.href;
    },
    async finishAuth(code, state) {
      const expires = states.get(state);
      states.delete(state);
      if (!expires || expires <= Date.now()) throw new ServiceError(400, "Sign-in link expired. Try connecting again.");
      const token = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
      const granted = new Set((token.scope ?? "").split(" "));
      if (!CALENDAR_SCOPES.every(scope => granted.has(scope))) {
        throw new ServiceError(403, "Both calendar permissions are needed. Connect again and leave both boxes ticked.");
      }
      if (!token.refresh_token) throw new ServiceError(502, "Google did not return a refresh token. Connect again.");
      await save({ accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 });
    },
    async disconnect() {
      const current = await load();
      await save(null);
      if (current) await fetcher(REVOKE_URL, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: current.refreshToken }),
      }).catch(() => { /* The local token is already gone; revocation is best effort. */ });
    },
    async busy(from, to) {
      const result = z.object({ calendars: z.record(z.string(), z.object({
        busy: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
        errors: z.array(z.unknown()).optional(),
      })) }).safeParse(await api("/freeBusy", { method: "POST", body: JSON.stringify({
        timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }],
      }) }));
      const primary = result.success ? Object.values(result.data.calendars)[0] : undefined;
      if (!primary || primary.errors?.length) throw new ServiceError(502, "Google Calendar did not return availability.");
      return primary.busy.map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
    },
    async findEvent(eventId) {
      const query = new URLSearchParams({ privateExtendedProperty: "riftboundEventId=" + eventId, maxResults: "1" });
      const result = await api("/calendars/primary/events?" + query) as { items?: unknown[] };
      return (result.items?.length ?? 0) > 0;
    },
    async addEvent(event, hours) {
      const window = eventWindow(event, hours);
      if (!window) throw new ServiceError(409, "This event has no known start time, so it can't be added to your calendar.");
      await api("/calendars/primary/events", { method: "POST", body: JSON.stringify({
        summary: "Riftbound: " + event.title,
        location: event.address || [event.store, event.location].filter(Boolean).join(", "),
        description: [
          "Approved in the Riftbound agent. Registration is still pending, so check the event page.",
          event.price === null ? "Price unknown" : "Entry: $" + event.price.toFixed(2),
          `Calendar block assumes ${hours} hours; the real end time is not published.`,
          event.url,
        ].join("\n"),
        start: { dateTime: new Date(window.start).toISOString() },
        end: { dateTime: new Date(window.end).toISOString() },
        source: { title: "Riftbound event", url: event.url },
        extendedProperties: { private: { riftboundEventId: event.id } },
      }) });
    },
  };
}

export function calendarFromEnv(): CalendarService {
  const port = Number(process.env.PORT || 3001);
  return createGoogleCalendar({
    clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/api/calendar/callback`,
    tokenFile: process.env.GOOGLE_TOKEN_FILE || ".google-calendar-token.json",
  });
}
