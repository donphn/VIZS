import "dotenv/config";
import { createHandler } from "./app.js";
import { calculateSplit, formatSummary } from "./calc/index.js";
import { startBot } from "./photon/index.js";
import { SessionManager } from "./session/index.js";
import { analyzeReceipt } from "./vision/index.js";

if (!process.env.GROK_API_KEY) {
  console.error("Missing GROK_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const session = new SessionManager({ calculateSplit, formatSummary });

await startBot(createHandler({ analyzeReceipt, session }));
console.log("🧾 Receipt splitter is running. Send a receipt photo to a chat with your Photon line.");
