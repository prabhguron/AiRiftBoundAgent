import { LiveServerMessage } from "@google/genai";
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../app.js";
import { parseEvents, scrapeEvents, ServiceError, type Search } from "../events.js";
import { recommend, resolveCards, type LiveConnector } from "../recommend.js";

const raw = { data: [{ results: [{
  text: "Nov\n21\nSaturday 6 PM\nNexus Night\nNEXUS_NIGHT\n$12.50\n4/16\nRegister\nCard Shop • 2 km • Surrey",
  attributes: [{ name: "href", value: "/en-US/events/example" }],
}] }] };
const events = parseEvents(raw);
const search: Search = { preferences: "Under $20", location: "Surrey", latitude: 49.19, longitude: -122.85 };
const selections = { recommendations: [{ eventId: events[0]!.id, reason: "Within your budget." }] };

test("parser preserves price, capacity and trusted event URL", () => {
  assert.equal(events[0]!.price, 12.5);
  assert.equal(events[0]!.capacity, 16);
  assert.equal(events[0]!.location, "Surrey");
  assert.equal(events[0]!.url, "https://playriftbound.com/en-US/events/example");
  const unknown = structuredClone(raw);
  unknown.data[0]!.results[0]!.text = unknown.data[0]!.results[0]!.text.replace("$12.50", "TBA");
  assert.equal(parseEvents(unknown)[0]!.price, null);
});
test("parser rejects external URLs and malformed upstream responses", () => {
  const external = structuredClone(raw);
  external.data[0]!.results[0]!.attributes[0]!.value = "https://evil.example/en-US/events/1";
  assert.throws(() => parseEvents(external), ServiceError);
  assert.throws(() => parseEvents({}), ServiceError);
  assert.deepEqual(parseEvents({ data: [{ results: [] }] }), []);
});
test("recommendations cannot replace scraped fields or invent events", () => {
  assert.equal(resolveCards(selections, events)[0]!.price, 12.5);
  assert.throws(() => resolveCards({ recommendations: [{ eventId: "invented", reason: "test" }] }, events));
  assert.throws(() => resolveCards({ recommendations: [...selections.recommendations, ...selections.recommendations] }, events));
  assert.throws(() => resolveCards({ recommendations: [{ eventId: events[0]!.id, reason: "" }] }, events));
});

test("Live sends preferences, receives function arguments, acknowledges and closes", async () => {
  const old = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only";
  let closed = 0;
  let acknowledged = 0;
  try {
    const connector: LiveConnector = async parameters => {
      assert.equal(parameters.model, process.env.GEMINI_MODEL || "gemini-3.8-live");
      assert.deepEqual(parameters.config?.responseModalities, ["AUDIO"]);
      assert.match(JSON.stringify(parameters.config?.tools), /submit_recommendations/);
      return {
        sendClientContent: input => {
          assert.equal(input.turnComplete, true);
          assert.match(JSON.stringify(input.turns), /Under \$20/);
          queueMicrotask(() => parameters.callbacks.onmessage(Object.assign(new LiveServerMessage(), {
            toolCall: { functionCalls: [{ id: "call1", name: "submit_recommendations", args: selections }] },
          })));
        },
        sendToolResponse: input => {
          acknowledged++;
          assert.equal((input.functionResponses as { id: string }[])[0]!.id, "call1");
        },
        close: () => { closed++; },
      };
    };
    assert.equal((await recommend(search, events, connector))[0]!.id, events[0]!.id);
    assert.equal(acknowledged, 1);
    assert.equal(closed, 1);
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});

test("Live rejects malformed, unknown and missing selections and closes every session", async () => {
  const old = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only";
  try {
    const messages = [
      { toolCall: { functionCalls: [{ id: "1", name: "submit_recommendations", args: { recommendations: "bad" } }] } },
      { toolCall: { functionCalls: [{ id: "1", name: "submit_recommendations", args: { recommendations: [{ eventId: "invented", reason: "test" }] } }] } },
      { toolCall: { functionCalls: [{ id: "1", name: "register", args: selections }] } },
      { serverContent: { turnComplete: true } },
    ];
    for (const message of messages) {
      let closed = false;
      const connector: LiveConnector = async parameters => ({
        sendClientContent: () => queueMicrotask(() => parameters.callbacks.onmessage(Object.assign(new LiveServerMessage(), message))),
        sendToolResponse: () => assert.fail("Invalid output must not be acknowledged."),
        close: () => { closed = true; },
      });
      await assert.rejects(recommend(search, events, connector), ServiceError);
      assert.equal(closed, true);
    }
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});

test("Live handles quotas, early closure, timeouts and late connections", async () => {
  const old = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only";
  try {
    await assert.rejects(recommend(search, events, async () => { throw { status: 429 }; }),
      (e: unknown) => e instanceof ServiceError && e.status === 429);
    let closed = 0;
    const stalled: LiveConnector = async () => ({
      sendClientContent: () => {}, sendToolResponse: () => {}, close: () => { closed++; },
    });
    await assert.rejects(recommend(search, events, stalled, 10),
      (e: unknown) => e instanceof ServiceError && e.status === 504);
    assert.equal(closed, 1);
    const earlyClose: LiveConnector = async parameters => ({
      sendClientContent: () => parameters.callbacks.onclose?.({ reason: "disconnected" } as CloseEvent),
      sendToolResponse: () => {}, close: () => { closed++; },
    });
    await assert.rejects(recommend(search, events, earlyClose), ServiceError);
    assert.equal(closed, 2);
    let release!: (session: Awaited<ReturnType<LiveConnector>>) => void;
    const late: LiveConnector = () => new Promise(resolve => { release = resolve; });
    await assert.rejects(recommend(search, events, late, 10),
      (e: unknown) => e instanceof ServiceError && e.status === 504);
    release({ sendClientContent: () => assert.fail("Must not send after timeout."),
      sendToolResponse: () => {}, close: () => { closed++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 3);
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});


test("scraper sends search coordinates and normalizes results", async () => {
  const old = process.env.BROWSERLESS_TOKEN;
  process.env.BROWSERLESS_TOKEN = "test-only";
  try {
    const result = await scrapeEvents(search, async (_url, init) => {
      const target = new URL(JSON.parse(String(init?.body)).url);
      assert.equal(target.searchParams.get("lat"), "49.19");
      assert.equal(target.searchParams.get("q"), "Surrey");
      return Response.json(raw);
    });
    assert.equal(result.length, 1);
  } finally { if (old === undefined) delete process.env.BROWSERLESS_TOKEN; else process.env.BROWSERLESS_TOKEN = old; }
});

test("API returns cards, validates approval, logs once, and serves the demo", async () => {
  const logs: string[] = [];
  let calls = 0;
  const app = createApp({
    scrape: async () => { calls++; return events; },
    recommend: async () => resolveCards(selections, events),
    log: message => logs.push(message),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const post = (path: string, body: unknown) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.match(await (await fetch(base)).text(), /Find a Riftbound event/);
    assert.equal((await post("/api/recommendations", { ...search, latitude: 999 })).status, 400);
    assert.equal(calls, 0);
    const response = await post("/api/recommendations", search);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.cards.length, 1);
    assert.equal((await post("/api/approvals", { requestId: result.requestId, eventId: "invented" })).status, 404);
    assert.equal((await post("/api/approvals", { requestId: "unknown", eventId: events[0]!.id })).status, 404);
    for (let i = 0; i < 2; i++) {
      assert.equal((await post("/api/approvals", { requestId: result.requestId, eventId: events[0]!.id })).status, 200);
    }
    assert.deepEqual(logs, ["approval"]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
