import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { CALENDAR_SCOPES, checkRange, createGoogleCalendar, markConflicts, type Busy, type CalendarService } from "../calendar.js";
import { ServiceError, type Event } from "../events.js";
import { resolveCards } from "../recommend.js";

const at = (iso: string) => Date.parse(iso);
const base: Event = {
  id: "a1", title: "Nexus Night", date: "", type: "NEXUS_NIGHT", price: 10, players: 2, capacity: 16,
  store: "Card Shop", distance: "2 km", location: "Surrey", url: "https://playriftbound.com/en-US/events/a1",
};
const evening = { ...base, id: "a1", startsAt: "2030-01-10T02:00:00Z" }; // 02:00-05:00 UTC
const morning = { ...base, id: "b2", startsAt: "2030-01-11T17:00:00Z" };
const noTime = { ...base, id: "c3" };

test("marks events that overlap busy blocks, leaving touching edges free", () => {
  const busy: Busy[] = [{ start: at("2030-01-10T04:00:00Z"), end: at("2030-01-10T06:00:00Z") },
    { start: at("2030-01-11T15:00:00Z"), end: at("2030-01-11T17:00:00Z") }];
  const range = checkRange([evening, morning, noTime], 3, at("2030-01-01T00:00:00Z"))!;
  const marked = markConflicts([evening, morning, noTime], busy, range, 3);
  assert.deepEqual(marked.map(e => e.calendarStatus), ["conflict", "free", "unknown"]);
});

test("check range starts now, skips past events and is capped", () => {
  const now = at("2030-01-10T03:00:00Z");
  const far = { ...base, id: "d4", startsAt: "2030-06-01T00:00:00Z" };
  const range = checkRange([evening, far], 3, now)!;
  assert.equal(range.start, now);
  assert.equal(range.end, now + 60 * 86400000);
  assert.equal(markConflicts([far], [], range, 3)[0]!.calendarStatus, "unknown");
  assert.equal(checkRange([noTime], 3), null);
});

// A tiny fake of Google's OAuth and Calendar endpoints.
function fakeGoogle(options: { scope?: string; busy?: { start: string; end: string }[] } = {}) {
  const calls: { url: string; body: string; auth: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, body, auth: new Headers(init?.headers).get("Authorization") ?? "" });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") return Response.json({ access_token: "fresh", expires_in: 3600 });
      return Response.json({ access_token: "first", refresh_token: "refresh", expires_in: 3600,
        scope: options.scope ?? CALENDAR_SCOPES.join(" ") });
    }
    if (url.endsWith("/freeBusy")) return Response.json({ calendars: { primary: { busy: options.busy ?? [] } } });
    if (url.includes("/events?")) return Response.json({ items: [] });
    if (url.endsWith("/calendars/primary/events")) return Response.json({ id: "x" });
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("");
    return new Response("not found", { status: 404 });
  };
  return { calls, fetcher };
}

test("OAuth: state is checked, both scopes required, tokens saved and refreshed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rb-cal-"));
  const google = fakeGoogle();
  const calendar = createGoogleCalendar({ clientId: "id", clientSecret: "secret",
    redirectUri: "http://localhost:3001/api/calendar/callback", tokenFile: join(dir, "token.json"), fetcher: google.fetcher });
  assert.equal(await calendar.isConnected(), false);
  const url = new URL(calendar.authUrl());
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("scope"), CALENDAR_SCOPES.join(" "));
  await assert.rejects(calendar.finishAuth("code", "wrong-state"), ServiceError);
  await calendar.finishAuth("code", url.searchParams.get("state")!);
  assert.equal(await calendar.isConnected(), true);
  assert.equal(JSON.parse(await readFile(join(dir, "token.json"), "utf8")).refreshToken, "refresh");
  // A state can only be used once.
  await assert.rejects(calendar.finishAuth("code", url.searchParams.get("state")!), ServiceError);

  const busy = await calendar.busy(new Date(), new Date(Date.now() + 3600000));
  assert.deepEqual(busy, []);
  assert.equal(google.calls.at(-1)!.auth, "Bearer first");

  // Pretend the access token expired, then check it is refreshed before the next call.
  const saved = JSON.parse(await readFile(join(dir, "token.json"), "utf8"));
  const expired = createGoogleCalendar({ clientId: "id", clientSecret: "secret", redirectUri: "x",
    tokenFile: join(dir, "token.json"), fetcher: google.fetcher });
  await writeFile(join(dir, "token.json"), JSON.stringify({ ...saved, expiresAt: 0 }));
  await expired.addEvent(evening, 3);
  assert.equal(google.calls.at(-1)!.auth, "Bearer fresh");
  const inserted = JSON.parse(google.calls.at(-1)!.body);
  assert.equal(inserted.start.dateTime, "2030-01-10T02:00:00.000Z");
  assert.equal(inserted.end.dateTime, "2030-01-10T05:00:00.000Z");
  assert.equal(inserted.extendedProperties.private.riftboundEventId, "a1");

  await expired.disconnect();
  assert.equal(await expired.isConnected(), false);
  assert.match(google.calls.at(-1)!.url, /revoke/);
});

test("OAuth rejects a sign-in that unticks a calendar permission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rb-cal-"));
  const calendar = createGoogleCalendar({ clientId: "id", clientSecret: "secret", redirectUri: "x",
    tokenFile: join(dir, "token.json"), fetcher: fakeGoogle({ scope: CALENDAR_SCOPES[0] }).fetcher });
  const state = new URL(calendar.authUrl()).searchParams.get("state")!;
  await assert.rejects(calendar.finishAuth("code", state), (e: unknown) => e instanceof ServiceError && e.status === 403);
  assert.equal(await calendar.isConnected(), false);
});

test("API skips clashing events and only adds free approved events to the calendar", async () => {
  let busy: Busy[] = [{ start: at("2030-01-11T18:00:00Z"), end: at("2030-01-11T19:00:00Z") }];
  const added: string[] = [];
  const logs: string[] = [];
  const calendar: CalendarService = {
    configured: true,
    isConnected: async () => true,
    authUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    finishAuth: async () => {},
    disconnect: async () => {},
    busy: async (from, to) => busy.filter(b => b.start < to.getTime() && b.end > from.getTime()),
    findEvent: async id => added.includes(id),
    addEvent: async event => { added.push(event.id); },
  };
  let offered: Event[] = [];
  const app = createApp({
    scrape: async () => [evening, morning, noTime],
    recommend: async (_search, events) => {
      offered = events;
      return resolveCards({ recommendations: events.map(e => ({ eventId: e.id, reason: "Fits." })) }, events);
    },
    log: message => logs.push(message),
    calendar,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = "http://127.0.0.1:" + address.port;
  const post = (path: string, body: unknown) => fetch(root + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.deepEqual(await (await fetch(root + "/api/calendar")).json(), { configured: true, connected: true });
    const connect = await fetch(root + "/api/calendar/connect", { redirect: "manual" });
    assert.equal(connect.status, 302);
    const response = await post("/api/recommendations",
      { preferences: "anything", location: "Surrey", latitude: 49.19, longitude: -122.85 });
    const result = await response.json();
    assert.deepEqual(offered.map(e => e.id), ["a1", "c3"]);
    assert.match(result.message, /1 skipped/);
    assert.equal(result.cards[0].calendarStatus, "free");

    // The calendar changed after the search, so approval must check again.
    busy = [...busy, { start: at("2030-01-10T03:00:00Z"), end: at("2030-01-10T04:00:00Z") }];
    assert.equal((await post("/api/approvals", { requestId: result.requestId, eventId: "a1" })).status, 409);
    busy = busy.slice(0, 1);
    const ok = await post("/api/approvals", { requestId: result.requestId, eventId: "a1" });
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).message, /added to your Google Calendar/);
    assert.equal((await post("/api/approvals", { requestId: result.requestId, eventId: "a1" })).status, 200);
    assert.deepEqual(added, ["a1"]);
    // Without a start time the event cannot be checked, so it is not approved.
    assert.equal((await post("/api/approvals", { requestId: result.requestId, eventId: "c3" })).status, 409);
    assert.deepEqual(logs, ["approval"]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
