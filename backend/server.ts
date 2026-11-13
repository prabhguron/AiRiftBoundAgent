import "dotenv/config";
import { createApp } from "./app.js";
import { Scrape } from "../Scrape.js";

const port = Number(process.env.PORT || 3001);

const app = createApp();

// Riftbound events API
app.get("/api/events", async (req, res) => {
  try {
    const events = await Scrape();

    res.json({
      message: "Riftbound Events API",
      status: "success",
      events: events,
    });
  } catch (error) {
    console.error("Error scraping events:", error);

    res.status(500).json({
      message: "Failed to fetch Riftbound events",
      status: "error",
    });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Riftbound event agent: http://localhost:${port}`);
});