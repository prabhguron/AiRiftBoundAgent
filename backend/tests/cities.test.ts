import { test } from "node:test";
import assert from "node:assert/strict";
import { searchCities } from "../cities.js";
import { ServiceError } from "../events.js";

test("city lookup returns coordinates and timezone, excluding non-city or invalid results", async () => {
  const cities = await searchCities(" Vancouver ", async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("name"), "Vancouver");
    const city = { id: 1, name: "Vancouver", admin1: "British Columbia", country: "Canada",
      latitude: 49.24966, longitude: -123.11934, timezone: "America/Vancouver", feature_code: "PPLA2" };
    return Response.json({ results: [city, { ...city, id: 2, feature_code: "ADM1" },
      { ...city, id: 3, timezone: "invalid" }, { ...city, id: 4, latitude: 999 }] });
  });
  assert.deepEqual(cities, [{ id: 1, label: "Vancouver, British Columbia, Canada",
    latitude: 49.24966, longitude: -123.11934, timeZone: "America/Vancouver" }]);
});
test("city lookup handles empty matches and upstream errors", async () => {
  assert.deepEqual(await searchCities("x", async () => { throw new Error("Must not fetch"); }), []);
  assert.deepEqual(await searchCities("Unknown", async () => Response.json({})), []);
  await assert.rejects(searchCities("Surrey", async () => new Response("", { status: 429 })), ServiceError);
});

