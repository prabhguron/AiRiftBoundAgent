# AiRiftBoundAgent

Recommends Riftbound Nexus Night events from the existing Browserless scraper.
The backend fetches public event descriptions before Gemini ranks events by the requested priorities.
Cards show published reward excerpts and expandable descriptions, with unknown rewards labeled clearly.
Approving a card logs exactly `approval` in the server terminal. Registration is a teammate's next step.

## Run

Use Node.js 22 or newer. From this folder:

```powershell
npm install
Copy-Item .env.example .env
```

Fill in `GEMINI_API_KEY` and `BROWSERLESS_TOKEN` in your local `.env`, then:

```powershell
npm start
```

Open http://localhost:3001. Search for a city, select it from the dropdown, and enter your preferences. City lookup fills in coordinates and time zone automatically using Open-Meteo and GeoNames.
Only Nexus Night events are currently scraped, matching the original scraper.

Gemini defaults to `gemini-3.8-live` using the Google GenAI SDK's Live WebSocket API.
The backend sends text preferences and scraped events, then receives structured selections
through the `submit_recommendations` function call. It validates the choices, acknowledges
the call, and closes the session. Audio output is not played or saved; no microphone is needed.
A session times out after 45 seconds. If the model answers without calling the function,
the API returns a clear error so the user can retry.
`GEMINI_MODEL` must name a compatible Live model. There is no fallback to a text model.
Use an eligible free-tier API project if you want free usage; quota and billing depend on your account.
Browserless requires its own token and has separate usage limits.
Keys remain on the backend. No Riot credentials are needed for this feature.

## Google Calendar

The agent can read your free/busy times and add approved events to your primary calendar.
When connected, search results skip events that overlap anything on your calendar, and
approval checks again before adding the event (the calendar may have changed since the search).
Approving the same event twice never adds it twice.

Setup (one time, about five minutes):

1. In Google Cloud Console, create a project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen as **External**, then add your own Google account under **Test users**.
3. Create an **OAuth client ID** of type **Web application** with this authorised redirect URI:
   `http://localhost:3001/api/calendar/callback`
4. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Run `npm start`, open http://localhost:3001, and click **Connect Google Calendar**.

Notes:

- Two scopes are requested: `calendar.freebusy` (busy times only, no event titles) and `calendar.events`
  (to add approved events). If either box is unticked on Google's screen, the connection is refused.
- Listings don't publish an end time, so each event is treated as a 3-hour block.
  Change this with `CALENDAR_EVENT_HOURS`.
- Events without a published start time are shown as "couldn't check" and can't be approved while
  the calendar is connected, because a clash can't be ruled out.
- Only the next 60 days are checked; later events are marked "couldn't check".
- Tokens are saved to `.google-calendar-token.json` (gitignored). Click **Disconnect** to delete
  the file and revoke access. This is a single-user demo: anyone using this server shares one calendar.
- If you change `PORT`, set `GOOGLE_REDIRECT_URI` to match and update it in Google Cloud too.

## API

`GET /api/cities?q=Surrey` returns `{ cities }` with ID, label, latitude, longitude and timeZone.
The dropdown uses this lookup; results are cached for one hour. No additional API key is needed.
The public Open-Meteo endpoint is for non-commercial use; review its terms before commercial deployment.

`POST /api/recommendations`:

```json
{
  "preferences": "Events under $20 this weekend",
  "location": "Surrey, BC, Canada",
  "latitude": 49.1913466,
  "longitude": -122.8490125
}
```

Returns `{ requestId, cards, message }`. Each card includes `id`, `title`, `date`,
`type`, `price`, `players`, `capacity`, `store`, `distance`, `location`, `url`, and `reason`.
Unknown numeric details are null. Cards also include description, rewards, startsAt, address,
detailsStatus and availability. Detail-page timestamps are shown in America/Vancouver by default;
API clients can supply an IANA timeZone. If details fail, the listing date is retained.
Next week means the next Monday through Sunday in that time zone. Full/waitlisted events are excluded.
Descriptions are fetched directly from public event pages, with four workers and a five-minute cache.
The model may return up to 20 matching cards from the fetched listing; the response reports the listing count.
This is not an exhaustive search of every event or listing page.

`POST /api/approvals`:

```json
{ "requestId": "value from recommendations", "eventId": "card id" }
```

Returns `{ status: "approved", eventId, message }`.
Only recommended events can be approved; repeated approvals log once.
Recommendations expire after 30 minutes or a restart. Up to 500 searches are retained in memory.
The request ID is an unguessable lookup token, not a user login: keep it private.
Replace the marked log in `backend/app.ts` with the registration handoff when ready.
Before adding real registration or deploying publicly, connect authentication and persistent
user-owned approval records. This demo binds to localhost and has no user accounts.

`GET /api/calendar` returns `{ configured, connected }`. `GET /api/calendar/connect` redirects to
Google's sign-in, which returns to `/api/calendar/callback`. `POST /api/calendar/disconnect` removes access.
When connected, cards include `calendarStatus` (`free` or `unknown`); clashing events are left out.
Approval returns 409 if the event clashes or has no start time.

Errors return `{ error }`: 400 invalid input, 404 missing/expired recommendation,
429 quota/concurrency limit, 502 upstream failure, 503 missing configuration, 504 timeout.
The demo uses same-origin calls; a separate frontend can proxy /api to this server.

## Checks

```powershell
npm run typecheck
npm test
```

Tests mock the scraper and Gemini; they do not use keys or register for events.
The existing Playwright login experiments are separate and are not run by `npm test`.
The original `Scrape.js` is retained as a prototype; the app uses `backend/events.ts`.
The parser follows that prototype's page layout and may need updating if Riftbound changes its markup.

References:
- https://aistudio.google.com/docs/pricing#gemini-3.8-live
- https://aistudio.google.com/docs/live-api/tools
