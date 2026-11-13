import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvents, type Search } from "../events.js";
import { enrichEvents, parseEventDetails, rewardDetails } from "../event-details.js";
import { filterCandidates } from "../event-filters.js";

const search: Search = { preferences: "under $20 event for the most rewards", location: "Surrey", latitude: 49.19, longitude: -122.85 };
const event = parseEvents({ data: [{ results: [{
  text: "NOV\n16\nMONDAY • 12:30 AM\nNEXUS NIGHTS @ DFT\nNexus Nights • 1v1 • Constructed\nCA$5\n1/30\n\nDraw For Turn Games • 11 mi. • Richmond, BC",
  attributes: [{ name: "href", value: "/en-US/events/12345" }],
}] }] })[0]!;
const description = "Pack prizing for all X-0 & X-1 records\nTies are counted as losses during prize out\n\nParticipation promos for all players while supplies last";
function html(description: string) {
  const record = "a:" + JSON.stringify({ children: { description, date: "2026-11-16T00:30:00Z", address: "Richmond, BC" } }) + "\n";
  const midpoint = Math.floor(record.length / 2);
  return [record.slice(0, midpoint), record.slice(midpoint)].map(chunk =>
    "<script>self.__next_f.push(" + JSON.stringify([1, chunk]) + ")</script>").join("");
}

test("venue parsing does not reuse weekday/time or event type", () => {
  assert.equal(event.store, "Draw For Turn Games");
  assert.equal(event.distance, "11 mi.");
  assert.equal(event.location, "Richmond, BC");
  assert.equal(event.date, "NOV 16 MONDAY • 12:30 AM");
});

test("detail parsing joins stream chunks, preserves conditions, and detects missing data", () => {
  const parsed = parseEventDetails(html(description));
  assert.equal(parsed?.description, description);
  assert.equal(parsed?.startsAt, "2026-11-16T00:30:00Z");
  assert.equal(rewardDetails(description), description);
  assert.equal(parseEventDetails(html(""))?.description, "");
  assert.equal(parseEventDetails("<html>No event data</html>"), null);
  assert.equal(rewardDetails("Casual games every week"), "");
});

test("enrichment converts UTC to local date and separates no rewards from a fetch failure", async () => {
  const result = await enrichEvents([event], "America/Vancouver", async () => new Response(html(description)));
  assert.equal(result[0]!.detailsStatus, "loaded");
  assert.match(result[0]!.date, /Sunday, Nov 15, 2026/);
  assert.match(result[0]!.rewards!, /X-0 & X-1/);
  const noRewards = await enrichEvents([event], "America/Vancouver", async () => new Response(html("")));
  assert.equal(noRewards[0]!.detailsStatus, "loaded");
  assert.equal(noRewards[0]!.rewards, "");
  const failed = await enrichEvents([event], "America/Vancouver", async () => new Response("", { status: 503 }));
  assert.equal(failed[0]!.detailsStatus, "unavailable");
});

test("price and availability checks do not restrict an unspecified date to weekends", () => {
  const now = new Date("2026-11-12T18:00:00Z");
  const candidates = [
    { ...event, id: "sunday", startsAt: "2026-11-16T00:30:00Z" },
    { ...event, id: "monday", startsAt: "2026-11-17T01:00:00Z" },
    { ...event, id: "wednesday", startsAt: "2026-11-19T01:00:00Z" },
    { ...event, id: "exact20", price: 20 },
    { ...event, id: "unknown", price: null },
    { ...event, id: "waitlisted", availability: "waitlist" as const },
    { ...event, id: "full", players: 30 },
  ];
  assert.deepEqual(filterCandidates(search, candidates, now).map(e => e.id), ["sunday", "monday", "wednesday"]);
  assert.deepEqual(filterCandidates({ ...search, preferences: search.preferences + " next week" }, candidates, now).map(e => e.id), ["monday", "wednesday"]);
  assert.equal(filterCandidates({ ...search, preferences: "up to $20" }, [candidates[3]!], now).length, 1);
});

