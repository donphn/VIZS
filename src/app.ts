import type { AnalyzeReceipt, BotHandlers, SessionApi } from "./types.js";

export function unreadableMessage(reason?: string): string {
  const why = reason ? ` (${reason.replace(/[.!]+$/, "")})` : "";
  return (
    `🧾 That looks like a receipt, but I can't read it clearly${why}. ` +
    "Try another photo: flat, well lit, and with the whole receipt in frame."
  );
}

export interface AppDeps {
  analyzeReceipt: AnalyzeReceipt;
  session: SessionApi;
  log?: Pick<Console, "log" | "error">;
}

/**
 * Wires vision + session into the Photon message loop.
 *
 * - Images: each one goes to Grok vision. The first that parses as a receipt starts a session.
 *   Non-receipt photos are ignored silently, so the bot only speaks up for receipts.
 * - Text: forwarded to the chat's session (if any). An empty reply list means stay quiet.
 */
export function createHandler({ analyzeReceipt, session, log = console }: AppDeps): BotHandlers {
  const send = async (reply: (text: string) => Promise<void>, messages: string[]) => {
    for (const m of messages) await reply(m);
  };

  return {
    async onMessage(msg, reply) {
      if (msg.images.length > 0) {
        let unreadable: { reason?: string } | undefined;
        for (const image of msg.images) {
          let result;
          try {
            result = await analyzeReceipt(image);
          } catch (err) {
            log.error("[app] vision failed", err);
            await reply("😕 I couldn't read that photo just now. If it's a receipt, try sending it again in a moment.");
            return;
          }
          if (result.status === "ok") {
            const { receipt } = result;
            log.log(`[app] receipt in ${msg.chatId}: ${receipt.items.length} items, total ${receipt.total}`);
            await send(reply, session.start(msg.chatId, receipt));
            return;
          }
          if (result.status === "unreadable") unreadable ??= result;
        }
        if (unreadable) {
          log.log(`[app] unreadable receipt in ${msg.chatId}: ${unreadable.reason ?? "no reason"}`);
          await reply(unreadableMessage(unreadable.reason));
          return;
        }
        log.log(`[app] non-receipt image in ${msg.chatId}, ignoring`);
        // A photo plus a caption: still let the caption reach an active session.
      }

      if (msg.text?.trim()) {
        await send(reply, session.handleText(msg.chatId, msg.senderId, msg.text));
      }
    },
  };
}
