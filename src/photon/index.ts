import type { Message, Space } from "spectrum-ts";
import type { BotHandlers } from "../types.js";
import { createSpectrumClient, type SpectrumClient } from "./client.js";
import { toIncomingMessage } from "./mapper.js";

export { toIncomingMessage, isOwnMessage, isGroupSpace } from "./mapper.js";
export { readPhotonCredentials } from "./client.js";

export interface StartBotOptions {
  /** Install SIGINT/SIGTERM handlers that call stop() and exit (default true). */
  handleSignals?: boolean;
  /** Convert HEIC photos (the iPhone default) to JPEG before handing them to handlers (default true). */
  convertHeic?: boolean;
}

/** Converts HEIC to JPEG with heic-convert, a pure JS/WASM package with no native deps. Loaded lazily. */
async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  const { default: convert } = await import("heic-convert");
  const out = await convert({ buffer: new Uint8Array(bytes), format: "JPEG", quality: 0.9 });
  return Buffer.from(out);
}

/**
 * Serial task queue per key. Tasks for one chat run in order; different chats run concurrently.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  push(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => {
      console.error(`[photon] task failed for chat ${key}`, err);
    });
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  async drain(): Promise<void> {
    while (this.tails.size > 0) await Promise.allSettled([...this.tails.values()]);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Connect to Photon Spectrum (iMessage) and route every inbound message to `handlers.onMessage`.
 *
 * - Inbound messages arrive on a long-lived gRPC stream (`app.messages`), so no webhook or public URL is needed.
 * - The bot's own messages are dropped. The SDK already filters isFromMe, and the mapper checks direction and sender.kind again.
 * - Each chat has its own serial queue. Errors are caught per message.
 * - If the stream ends or throws, the client is rebuilt with exponential backoff.
 */
export async function startBot(
  handlers: BotHandlers,
  options: StartBotOptions = {},
): Promise<{ stop(): Promise<void> }> {
  const { handleSignals = true, convertHeic = true } = options;
  const queue = new KeyedQueue();
  let stopping = false;
  let app: SpectrumClient = await createSpectrumClient();
  console.log("[photon] connected to Spectrum (iMessage)");

  const handle = async (space: Space, message: Message) => {
    const incoming = await toIncomingMessage(space, message, {
      convertHeic: convertHeic ? heicToJpeg : undefined,
    });
    console.log(
      `[photon] event chat=${space.id} content=${(message as { content?: { type?: string } }).content?.type ?? "?"}` +
        (incoming ? ` images=${incoming.images.length} text=${incoming.text ? "yes" : "no"}` : " (ignored)"),
    );
    if (!incoming) return;
    const reply = async (text: string) => {
      await space.send(text);
    };
    // responding() shows a typing indicator while the handler runs.
    await space.responding(() => handlers.onMessage(incoming, reply));
  };

  const loop = async () => {
    let backoff = 1000;
    while (!stopping) {
      try {
        for await (const [space, message] of app.messages) {
          if (stopping) break;
          backoff = 1000;
          void queue.push(space.id, () => handle(space, message));
        }
        if (stopping) break;
        console.warn("[photon] message stream ended; reconnecting");
      } catch (err) {
        if (stopping) break;
        console.error("[photon] message stream error; reconnecting", err);
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
      if (stopping) break;
      try {
        await app.stop().catch(() => {});
        app = await createSpectrumClient();
        console.log("[photon] reconnected");
      } catch (err) {
        console.error("[photon] reconnect failed", err);
      }
    }
  };

  // The pending stream keeps the event loop, and so the process, alive.
  const loopDone = loop();

  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= (async () => {
      stopping = true;
      if (handleSignals) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
      // Give in-flight handlers up to 10s to finish their replies before tearing down.
      await Promise.race([queue.drain(), sleep(10_000)]);
      await app.stop().catch((err) => console.error("[photon] error during stop", err));
      await Promise.race([loopDone, sleep(2_000)]);
      console.log("[photon] stopped");
    })();
    return stopPromise;
  };

  function onSignal(signal: NodeJS.Signals) {
    console.log(`[photon] received ${signal}, shutting down`);
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  }
  if (handleSignals) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  return { stop };
}
