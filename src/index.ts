import "dotenv/config";
import { startBot } from "./photon/index.js";

// TEMPORARY stub handler. The integrator replaces this with the real vision, session, and calc wiring.
await startBot({
  async onMessage(msg, reply) {
    console.log("[bot] incoming", {
      chatId: msg.chatId,
      senderId: msg.senderId,
      isGroup: msg.isGroup,
      text: msg.text,
      images: msg.images.map((i) => (i.kind === "url" ? i.url : `${i.mimeType} (${i.data.length} b64 chars)`)),
    });
    if (msg.images.length > 0) await reply("📸 got an image");
  },
});
