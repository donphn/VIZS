import { describe, expect, it } from "vitest";
import { createHandler } from "./app.js";
import { calculateSplit, formatSummary } from "./calc/index.js";
import { SessionManager } from "./session/index.js";
import type { ImageInput, IncomingMessage, ReceiptAnalysis } from "./types.js";
import { classifyReceipt, normalizeReceipt } from "./vision/index.js";

// What Grok would return for a 3-item dinner; run through the real normalizer.
const grokJson = {
  is_receipt: true,
  merchant: "Joe's Diner",
  currency: "USD",
  items: [
    { name: "Burger", price: "$14.00", quantity: 1 },
    { name: "Salad", price: 12, quantity: 1 },
    { name: "Fries", price: 6, quantity: 1 },
  ],
  subtotal: 32,
  tax: 2.88,
  tip: 6.4,
  total: 41.28,
};
const receipt = normalizeReceipt(grokJson)!;
const photo: ImageInput = { kind: "base64", data: "AAAA", mimeType: "image/jpeg" };

function harness(analyze: (img: ImageInput) => Promise<ReceiptAnalysis>) {
  const session = new SessionManager({ calculateSplit, formatSummary });
  const handler = createHandler({ analyzeReceipt: analyze, session, log: { log() {}, error() {} } });
  const sent: string[] = [];
  const say = async (partial: Partial<IncomingMessage>) => {
    const before = sent.length;
    const msg: IncomingMessage = { chatId: "chat;+;1", senderId: "+15550001", isGroup: true, images: [], ...partial };
    await handler.onMessage(msg, async (t) => void sent.push(t));
    return sent.slice(before);
  };
  return { say, sent };
}

describe("end-to-end flow", () => {
  it("receipt photo → count → claims → payer → summary", async () => {
    const { say } = harness(async () => ({ status: "ok", receipt }));

    const opening = await say({ images: [photo] });
    expect(opening.join("\n")).toMatch(/How many people/i);

    expect((await say({ text: "2" })).join("\n")).toMatch(/Person 1/);
    expect(await say({ text: "Alex: 1, 3" })).toHaveLength(1);
    await say({ text: "Sam: 2, 3" });
    const final = (await say({ text: "done" })).join("\n");

    expect(final).toContain("Joe's Diner");
    expect(final).toContain("Alex");
    expect(final).toContain("Sam");
    expect(final).toContain("$41.28");
    expect(final).not.toContain("Double-check");
  });

  it("stays silent for non-receipt photos and chit-chat with no session", async () => {
    const { say, sent } = harness(async () => ({ status: "not_receipt" }));
    await say({ images: [photo] });
    await say({ text: "lol nice pic" });
    expect(sent).toEqual([]);
  });

  it("tells the group when a receipt is unreadable", async () => {
    const { say } = harness(async () => ({ status: "unreadable", reason: "too blurry." }));
    const out = await say({ images: [photo] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/can't read it clearly \(too blurry\)/);
  });

  it("prefers a readable receipt when several photos are sent", async () => {
    const results: ReceiptAnalysis[] = [{ status: "unreadable" }, { status: "ok", receipt }];
    const { say } = harness(async () => results.shift()!);
    const out = (await say({ images: [photo, photo] })).join("\n");
    expect(out).toMatch(/How many people/i);
    expect(out).not.toMatch(/can't read/);
  });

  it("reports vision failures politely", async () => {
    const { say } = harness(async () => {
      throw new Error("boom");
    });
    expect((await say({ images: [photo] }))[0]).toMatch(/couldn't read/);
  });

  it("does not adjust shares for a wildly misread total, and flags it", async () => {
    const bad = { ...receipt, total: 412.8 };
    const result = calculateSplit({
      receipt: bad,
      participants: [{ label: "A", itemIds: [1, 2, 3] }],
    });
    expect(result.grandTotal).toBe(41.28);
    expect(formatSummary(result, bad)).toContain("Double-check");
  });
});

describe("classifyReceipt", () => {
  it("classifies Grok output", () => {
    expect(classifyReceipt(grokJson).status).toBe("ok");
    expect(classifyReceipt({ is_receipt: false, items: [] })).toEqual({ status: "not_receipt" });
    expect(classifyReceipt("not json at all")).toEqual({ status: "not_receipt" });
    expect(classifyReceipt({ is_receipt: true, readable: false, unreadable_reason: "cut off", items: [] })).toEqual({
      status: "unreadable",
      reason: "cut off",
    });
    // Says readable but no usable items → still unreadable.
    expect(classifyReceipt({ is_receipt: true, readable: true, items: [] }).status).toBe("unreadable");
  });
});
