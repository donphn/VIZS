import { describe, expect, it, vi } from "vitest";
import type { Message, Space, User } from "spectrum-ts";
import { isGroupSpace, toIncomingMessage } from "./mapper.js";
import { KeyedQueue } from "./index.js";

// Fixtures follow the real spectrum-ts iMessage shapes: space { id, type, phone }, sender { id, address, service }.
type Fixture = Pick<Message, "direction" | "sender" | "content">;

const groupSpace = {
  __platform: "imessage",
  id: "iMessage;+;chat123456",
  type: "group",
  phone: "+15550000000",
} as unknown as Space;

const dmSpace = {
  __platform: "imessage",
  id: "iMessage;-;+15551112222",
  type: "dm",
  phone: "+15550000000",
} as unknown as Space;

const alice = { __platform: "imessage", id: "+15551112222", address: "+15551112222", service: "iMessage" } as User;

const attachment = (name: string, mimeType: string, bytes = "img-bytes") => ({
  type: "attachment" as const,
  id: `guid-${name}`,
  name,
  mimeType,
  size: bytes.length,
  read: vi.fn(async () => Buffer.from(bytes)),
  stream: async () => new ReadableStream<Uint8Array>(),
});

const asItem = (content: Message["content"]) => ({ content }) as unknown as Message;

describe("toIncomingMessage", () => {
  it("maps a plain group text", async () => {
    const msg: Fixture = { direction: "inbound", sender: alice, content: { type: "text", text: " 1, 3 " } };
    expect(await toIncomingMessage(groupSpace, msg)).toEqual({
      chatId: "iMessage;+;chat123456",
      senderId: "+15551112222",
      senderName: undefined,
      isGroup: true,
      text: "1, 3",
      images: [],
    });
  });

  it("downloads image attachments as base64 and skips non-images", async () => {
    const pdf = attachment("menu.pdf", "application/pdf");
    const msg: Fixture = {
      direction: "inbound",
      sender: alice,
      content: {
        type: "group",
        items: [
          asItem({ type: "text", text: "split this" }),
          asItem(attachment("receipt.jpg", "image/jpeg", "jpegdata")),
          asItem(pdf),
        ],
      },
    };
    const out = await toIncomingMessage(dmSpace, msg);
    expect(out?.isGroup).toBe(false);
    expect(out?.text).toBe("split this");
    expect(out?.images).toEqual([
      { kind: "base64", data: Buffer.from("jpegdata").toString("base64"), mimeType: "image/jpeg" },
    ]);
    expect(pdf.read).not.toHaveBeenCalled();
  });

  it("converts HEIC via injected converter, and passes through on failure", async () => {
    const msg: Fixture = { direction: "inbound", sender: alice, content: attachment("IMG_1.HEIC", "image/heic") };
    const ok = await toIncomingMessage(groupSpace, msg, { convertHeic: async () => Buffer.from("jpg") });
    expect(ok?.images[0]).toEqual({ kind: "base64", data: Buffer.from("jpg").toString("base64"), mimeType: "image/jpeg" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = await toIncomingMessage(groupSpace, msg, {
      convertHeic: async () => {
        throw new Error("boom");
      },
    });
    expect(failed?.images[0]).toMatchObject({ kind: "base64", mimeType: "image/heic" });
    warn.mockRestore();
  });

  it("infers image mime from extension for octet-stream", async () => {
    const msg: Fixture = { direction: "inbound", sender: alice, content: attachment("r.png", "application/octet-stream") };
    expect((await toIncomingMessage(groupSpace, msg))?.images[0]).toMatchObject({ mimeType: "image/png" });
  });

  it("ignores own (outbound / agent) messages", async () => {
    const out: Fixture = { direction: "outbound", sender: alice, content: { type: "text", text: "hi" } };
    expect(await toIncomingMessage(groupSpace, out)).toBeNull();
    const agent: Fixture = {
      direction: "inbound",
      sender: { ...alice, kind: "agent" } as User,
      content: { type: "text", text: "hi" },
    };
    expect(await toIncomingMessage(groupSpace, agent)).toBeNull();
  });

  it("returns null for content with no text or images (e.g. typing)", async () => {
    const msg: Fixture = { direction: "inbound", sender: alice, content: { type: "typing", state: "start" } };
    expect(await toIncomingMessage(groupSpace, msg)).toBeNull();
  });

  it("survives a failing attachment download", async () => {
    const bad = attachment("x.jpg", "image/jpeg");
    bad.read.mockRejectedValueOnce(new Error("network"));
    const onAttachmentError = vi.fn();
    const msg: Fixture = {
      direction: "inbound",
      sender: alice,
      content: { type: "group", items: [asItem({ type: "text", text: "hey" }), asItem(bad)] },
    };
    const out = await toIncomingMessage(groupSpace, msg, { onAttachmentError });
    expect(out).toMatchObject({ text: "hey", images: [] });
    expect(onAttachmentError).toHaveBeenCalledOnce();
  });
});

describe("isGroupSpace", () => {
  it("falls back to the chat GUID when type is missing", () => {
    expect(isGroupSpace({ id: "any;+;chat1" })).toBe(true);
    expect(isGroupSpace({ id: "any;-;+1555" })).toBe(false);
  });
});

describe("KeyedQueue", () => {
  it("runs tasks per key in order and isolates errors", async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    q.push("a", async () => {
      await new Promise((r) => setTimeout(r, 20));
      log.push("a1");
    });
    q.push("a", async () => {
      throw new Error("bad");
    });
    q.push("a", async () => void log.push("a3"));
    q.push("b", async () => void log.push("b1"));
    await q.drain();
    expect(log).toEqual(["b1", "a1", "a3"]);
    err.mockRestore();
  });
});
