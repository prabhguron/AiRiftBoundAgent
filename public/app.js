import { createCityPicker } from "./city-picker.js";
const form = document.querySelector("#search");
const status = document.querySelector("#status");
const cards = document.querySelector("#cards");
const find = document.querySelector("#find");
const cityPicker = createCityPicker(document.querySelector("#city"), document.querySelector("#city-options"), document.querySelector("#city-status"));

// Send JSON to the backend and show useful errors.
async function post(path, data) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

// Render scraped details as text so event content cannot inject HTML.
function showCard(card, requestId) {
  const article = document.createElement("article");
  const text = (tag, value) => { const el = document.createElement(tag); el.textContent = value; article.append(el); };
  text("h2", card.title);
  text("p", [card.date, card.type].filter(Boolean).join(" · "));
  const venue = [card.store, card.location, card.distance].filter(Boolean).join(" · ");
  if (venue) text("p", venue);
  text("p", (card.price === null ? "Price unknown" : "$" + card.price.toFixed(2)) +
    (card.capacity === null ? "" : " · Players: " + (card.players ?? "?") + "/" + card.capacity));
  text("p", card.reason);
  text("p", card.rewards ? "Published rewards: " + card.rewards :
    card.detailsStatus === "loaded" ? "Rewards not specified in the event description." : "Reward details could not be loaded.");
  if (card.description) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Event description";
    const description = document.createElement("p");
    description.className = "event-description";
    description.textContent = card.description;
    details.append(summary, description);
    article.append(details);
  }
  const link = document.createElement("a");
  link.href = card.url; link.textContent = "View event"; link.target = "_blank"; link.rel = "noopener noreferrer"; article.append(link);
  const approve = document.createElement("button");
  approve.type = "button"; approve.textContent = "Approve";
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    try {
      const result = await post("/api/approvals", { requestId, eventId: card.id });
      approve.textContent = "Approved"; status.textContent = result.message;
    } catch (error) { status.textContent = error.message; approve.disabled = false; }
  });
  article.append(approve); cards.append(article);
}

// Enter searches; Shift+Enter keeps a new line in the preferences box.
form.querySelector('[name="preferences"]').addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!find.disabled) form.requestSubmit(find);
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (find.disabled || !cityPicker.requireSelection()) return;
  find.disabled = true; cards.replaceChildren(); status.textContent = "Finding matching events…";
  const values = new FormData(form);
  const city = cityPicker.getSelected();
  try {
    const result = await post("/api/recommendations", {
      preferences: values.get("preferences"), location: city.label,
      latitude: city.latitude, longitude: city.longitude, timeZone: city.timeZone,
    });
    status.textContent = result.message;
    result.cards.forEach(card => showCard(card, result.requestId));
  } catch (error) { status.textContent = error.message; }
  finally { find.disabled = false; }
});



