
const response = await fetch(
  'https://production-sfo.browserless.io/scrape?token="key',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://playriftbound.com/en-US/events?q=Surrey%2C+BC%2C+Canada&lat=49.191346599999996&lng=-122.84901249999999&types=NEXUS_NIGHT',
elements: [{ selector: 'a[href^="/en-US/events/"]:not([href="/en-US/events/"])' }]    })
  }
);
const data = await response.json();

const events = data.data[0].results;
for (let i = 0; i < events.length; i++) {
    console.log("Event:", i);
    console.log(events[i].text);
}
