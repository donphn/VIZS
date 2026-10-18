import { describe, expect, it, vi } from "vitest";
import type { CalculateSplit, FormatSummary, Receipt, SplitRequest, SplitResult } from "../types.js";
import { SessionManager } from "./session.js";
import {
  extractName,
  parseAssign,
  parseClaim,
  parseCommand,
  parseCount,
  parseIdList,
  parsePayer,
  partitionIds,
} from "./parse.js";

const receipt: Receipt = {
  merchant: "Joe's Diner",
  currency: "USD",
  items: [
    { id: 1, name: "Burger", price: 12, quantity: 1 },
    { id: 2, name: "Fries", price: 4.5, quantity: 1 },
    { id: 3, name: "Soda", price: 6, quantity: 2 },
    { id: 4, name: "Salad", price: 9, quantity: 1 },
    { id: 5, name: "Pie", price: 7, quantity: 1 },
  ],
  subtotal: 38.5,
  tax: 3.5,
  tip: 0,
  total: 42,
};

function setup(opts: { ttlMs?: number } = {}) {
  let clock = 1_000_000;
  const calls: SplitRequest[] = [];
  const calculateSplit: CalculateSplit = vi.fn((req: SplitRequest): SplitResult => {
    calls.push(req);
    return {
      shares: req.participants.map((p) => ({
        label: p.label, items: [], itemsSubtotal: 0, tax: 0, tip: 0, total: 0,
      })),
      unclaimed: [],
      payerLabel: req.participants[req.payerIndex ?? 0].label,
      grandTotal: req.receipt.total,
      settlements: [],
    };
  });
  const formatSummary: FormatSummary = vi.fn((r: SplitResult) => `SUMMARY payer=${r.payerLabel}`);
  const sm = new SessionManager({ calculateSplit, formatSummary, ttlMs: opts.ttlMs, now: () => clock });
  const say = (text: string, chat = "c1") => sm.handleText(chat, "s1", text);
  const advance = (ms: number) => { clock += ms; };
  return { sm, say, calls, calculateSplit, formatSummary, advance };
}

describe("parse helpers", () => {
  it("parseCount", () => {
    expect(parseCount("3")).toBe(3);
    expect(parseCount("three")).toBe(3);
    expect(parseCount("3 people")).toBe(3);
    expect(parseCount("We're four")).toBe(4);
    expect(parseCount("twenty")).toBe(20);
    expect(parseCount("25")).toBe(25);
    expect(parseCount("lol")).toBeNull();
    expect(parseCount("someone else is paying")).toBeNull();
    expect(parseCount("this is a really long message that mentions 7 somewhere")).toBeNull();
  });

  it("parseIdList", () => {
    expect(parseIdList("1, 3")).toEqual({ kind: "ids", ids: [1, 3] });
    expect(parseIdList("1 3 5")).toEqual({ kind: "ids", ids: [1, 3, 5] });
    expect(parseIdList("2-4")).toEqual({ kind: "ids", ids: [2, 3, 4] });
    expect(parseIdList("2 – 4")).toEqual({ kind: "ids", ids: [2, 3, 4] });
    expect(parseIdList("4-2")).toEqual({ kind: "ids", ids: [2, 3, 4] });
    expect(parseIdList("#1 and #3")).toEqual({ kind: "ids", ids: [1, 3] });
    expect(parseIdList("I had 1 & 3, 3")).toEqual({ kind: "ids", ids: [1, 3] });
    expect(parseIdList("none")).toEqual({ kind: "none" });
    expect(parseIdList("Nothing!")).toEqual({ kind: "none" });
    expect(parseIdList("no items")).toEqual({ kind: "none" });
    expect(parseIdList("lol")).toBeNull();
    expect(parseIdList("see you at 7:30")).toBeNull();
    expect(parseIdList("that was $12")).toBeNull();
    expect(parseIdList("")).toBeNull();
  });

  it("extractName", () => {
    expect(extractName("Alex: 1,3")).toEqual({ name: "Alex", rest: "1,3" });
    expect(extractName("alex kim: none")).toEqual({ name: "Alex Kim", rest: "none" });
    expect(extractName("I'm Alex 1 3")).toEqual({ name: "Alex", rest: "1 3" });
    expect(extractName("I’m Sam, 2")).toEqual({ name: "Sam", rest: "2" });
    expect(extractName("this is Jo and I had 4")).toEqual({ name: "Jo", rest: "and I had 4" });
    expect(extractName("1, 3")).toEqual({ rest: "1, 3" });
    expect(extractName("items: 1, 3")).toEqual({ rest: "items: 1, 3" });
    expect(extractName("I'm in for 2").name).toBeUndefined();
  });

  it("parseClaim", () => {
    expect(parseClaim("Alex: 1,3")).toEqual({ kind: "ids", ids: [1, 3], name: "Alex" });
    expect(parseClaim("Person 2: 4")).toEqual({ kind: "ids", ids: [4] });
    expect(parseClaim("I'm Bo none")).toEqual({ kind: "none", name: "Bo" });
    expect(parseClaim("haha same")).toBeNull();
    expect(parseClaim("I'm in for 2")).toBeNull();
  });

  it("parseCommand", () => {
    expect(parseCommand("Cancel")).toBe("cancel");
    expect(parseCommand("stop!")).toBe("cancel");
    expect(parseCommand("undo")).toBe("back");
    expect(parseCommand("back")).toBe("back");
    expect(parseCommand("OK")).toBe("done");
    expect(parseCommand("status")).toBe("status");
    expect(parseCommand("help")).toBe("help");
    expect(parseCommand("split")).toBe("split");
    expect(parseCommand("please stop talking")).toBeNull();
  });

  it("partitionIds / parseAssign / parsePayer", () => {
    expect(partitionIds([1, 7, 3, 9], [1, 2, 3])).toEqual({ valid: [1, 3], invalid: [7, 9] });
    expect(parseAssign("assign 4, 5 to 2")).toEqual({ items: "4, 5", target: "2" });
    expect(parseAssign("give 4 to Alex")).toEqual({ items: "4", target: "Alex" });
    expect(parseAssign("going to the store")).toBeNull();
    expect(parsePayer("2")).toEqual({ number: 2 });
    expect(parsePayer("person 3")).toEqual({ number: 3 });
    expect(parsePayer("paid by 2")).toEqual({ number: 2 });
    expect(parsePayer("Alex paid")).toEqual({ name: "alex" });
    expect(parsePayer("constructor")).toEqual({ name: "constructor" });
  });
});

describe("SessionManager", () => {
  it("is silent with no session", () => {
    const { sm, say } = setup();
    expect(sm.hasSession("c1")).toBe(false);
    expect(say("1, 3")).toEqual([]);
    expect(say("help")).toEqual([]);
    expect(say("cancel")).toEqual([]);
  });

  it("start shows merchant, total, numbered items, and asks for count", () => {
    const { sm } = setup();
    const out = sm.start("c1", receipt);
    expect(sm.hasSession("c1")).toBe(true);
    const all = out.join("\n");
    expect(all).toContain("Joe's Diner");
    expect(all).toContain("$42.00");
    expect(all).toContain("1. Burger $12.00");
    expect(all).toContain("3. 2x Soda $6.00");
    expect(all).toContain("5. Pie $7.00");
    expect(out[out.length - 1]).toBe("How many people are splitting this?");
    expect(all).not.toContain("discarded");
  });

  it("happy path: 3 people with names and a payer", () => {
    const { sm, say, calls, formatSummary } = setup();
    sm.start("c1", receipt);
    expect(say("3 people")[0]).toContain("How do you want to split it?");
    const r1 = say("items");
    expect(r1[0]).toContain("Person 1, which items did you have?");

    const r2 = say("Alex: 1, 2");
    expect(r2[0]).toContain("Alex: 1. Burger, 2. Fries");
    expect(r2[0]).toContain("Person 2, which items did you have?");
    expect(r2[0]).toMatch(/1\. Burger \$12\.00 ✓ Alex/);
    expect(r2[0]).toMatch(/4\. Salad \$9\.00$/m);

    const r3 = say("I'm Sam 3 4");
    expect(r3[0]).toContain("Sam: 3. Soda, 4. Salad");
    expect(r3[0]).toContain("Person 3, which items did you have?");

    const r4 = say("5");
    expect(r4[0]).toContain("Everyone's in");
    expect(r4[0]).toContain("Who's paying the bill? Reply with a person number (default 1).");
    expect(r4[0]).toContain("2. Sam");

    const r5 = say("2");
    expect(r5).toEqual(["SUMMARY payer=Sam"]);
    expect(sm.hasSession("c1")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      receipt,
      payerIndex: 1,
      participants: [
        { label: "Alex", itemIds: [1, 2] },
        { label: "Sam", itemIds: [3, 4] },
        { label: "Person 3", itemIds: [5] },
      ],
    });
    expect(formatSummary).toHaveBeenCalledWith(expect.anything(), receipt);
  });

  it("'done' finishes with default payer 0", () => {
    const { sm, say, calls } = setup();
    sm.start("c1", receipt);
    say("two");
    say("items");
    say("1-3");
    say("4 5");
    expect(say("done")).toEqual(["SUMMARY payer=Person 1"]);
    expect(calls[0].payerIndex).toBe(0);
  });

  it("re-prompts on invalid counts, nudges only once for chit-chat", () => {
    const { sm, say } = setup();
    sm.start("c1", receipt);
    expect(say("0")[0]).toMatch(/between 1 and 20/);
    expect(say("25 people")[0]).toMatch(/between 1 and 20/);
    expect(say("omg that was so good")[0]).toMatch(/How many people/);
    expect(say("lol yes")).toEqual([]);
    expect(say("4")[0]).toContain("Got it, 4 people");
  });

  it("rejects invalid item ids and re-asks the same person", () => {
    const { sm, say } = setup();
    sm.start("c1", receipt);
    say("2");
    say("items");
    const r = say("1, 7, 9");
    expect(r[0]).toContain("no item 7 or 9");
    expect(r[0]).toContain("items are 1-5");
    expect(r[0]).toContain("Person 1, which items did you have?");
    const r2 = say("2-6");
    expect(r2[0]).toContain("no item 6");
    // nothing was recorded; still Person 1
    expect(say("1")[0]).toContain("Person 2, which items");
  });

  it("ignores chit-chat during claiming", () => {
    const { sm, say } = setup();
    sm.start("c1", receipt);
    say("2");
    say("items");
    expect(say("haha that burger was huge")).toEqual([]);
    expect(say("ok")).toEqual([]);
    expect(say("who ordered pie?")).toEqual([]);
    expect(say("I'm so full")).toEqual([]);
    expect(say("see you at 7:30")).toEqual([]);
    expect(say("1")[0]).toContain("Person 2");
  });

  it("supports shared items (claimed by multiple people)", () => {
    const { sm, say, calls } = setup();
    sm.start("c1", receipt);
    say("2");
    say("items");
    say("1 2");
    const r = say("2, 3, 4, 5");
    expect(r[0]).toContain("Everyone's in");
    say("done");
    expect(calls[0].participants.map((p) => p.itemIds)).toEqual([[1, 2], [2, 3, 4, 5]]);
  });

  it("shows marks with multiple claimers", () => {
    const { sm, say } = setup();
    sm.start("c1", receipt);
    say("3");
    say("items");
    say("Alex: 2");
    const r = say("Bo: 2");
    expect(r[0]).toMatch(/2\. Fries \$4\.50 ✓ Alex, Bo/);
  });

  it("'none' claims nothing", () => {
    const { sm, say, calls } = setup();
    sm.start("c1", receipt);
    say("2");
    say("items");
    expect(say("none")[0]).toContain("Person 1: nothing");
    say("1-5");
    say("ok");
    expect(calls[0].participants[0].itemIds).toEqual([]);
  });

  it("unclaimed items: lists them, supports split", () => {
    const { sm, say, calls } = setup();
    sm.start("c1", receipt);
    say("2");
    say("items");
    say("1");
    const r = say("2");
    expect(r[0]).toContain("Nobody claimed");
    expect(r[0]).toContain("3. 2x Soda $6.00");
    expect(r[0]).toContain("5. Pie $7.00");
    expect(r[0]).toContain('"assign 3 to <person #>" or "split"');
    expect(r[0]).toContain("Who's paying the bill?");
    const r2 = say("split");
    expect(r2[0]).toContain("#3, #4 and #5 will be split evenly");
    // after split, a payer number finishes
    expect(say("2")).toEqual(["SUMMARY payer=Person 2"]);
    expect(calls[0].participants).toEqual([
      { label: "Person 1", itemIds: [1] },
      { label: "Person 2", itemIds: [2] },
    ]);
  });

  it("unclaimed items: assign to person number or name, then done", () => {
    const { sm, say, calls } = setup();
    sm.start("c1", receipt);
    say("3");
    say("items");
    say("Alex: 1");
    say("2");
    say("none");
    expect(say("assign 7 to 2")[0]).toContain("no item 7");
    expect(say("assign 3 to 9")[0]).toContain("no person 9");
    const r = say("assign 3, 4 to 2");
    expect(r[0]).toContain("3. Soda, 4. Salad → Person 2");
    expect(r[0]).toContain("5. Pie");
    expect(say("give 5 to alex")[0]).toContain("5. Pie → Alex");
    // payer number with nothing unclaimed finishes
    expect(say("3")).toEqual(["SUMMARY payer=Person 3"]);
    expect(calls[0].participants).toEqual([
      { label: "Alex", itemIds: [1, 5] },
      { label: "Person 2", itemIds: [2, 3, 4] },
      { label: "Person 3", itemIds: [] },
    ]);
  });

  it("payer with unclaimed pending just acknowledges; invalid payer re-asks", () => {
    const { sm, say, calls } = setup();
    sm.start("c1", receipt);
    say("2");
    say("items");
    say("1");
    say("2");
    expect(say("5")[0]).toContain("no person 5");
    expect(say("Bob paid")).toEqual([]); // unknown name: likely chit-chat
    const r = say("person 2");
    expect(r[0]).toContain("Person 2 is paying");
    expect(sm.hasSession("c1")).toBe(true);
    expect(say("done")).toEqual(["SUMMARY payer=Person 2"]);
    expect(calls[0].payerIndex).toBe(1);
  });

  it("undo redoes the previous person", () => {
    const { sm, say, calls } = setup();
    sm.start("c1", receipt);
    say("3");
    say("items");
    say("Alex: 1");
    say("2");
    const r = say("undo");
    expect(r[0]).toContain("redo Person 2");
    expect(r[0]).toContain("Person 2, which items did you have?");
    expect(r[0]).not.toMatch(/2\. Fries \$4\.50 ✓/);
    say("3");
    expect(say("back")[0]).toContain("redo Person 2");
    say("4");
    say("5");
    say("done");
    expect(calls[0].participants.map((p) => p.itemIds)).toEqual([[1], [4], [5]]);
  });

  it("undo from confirm goes back to the last person; undo at person 1 goes back to count", () => {
    const { sm, say, calls } = setup();
    sm.start("c1", receipt);
    say("1");
    expect(say("undo")[0]).toContain("How many people");
    say("2");
    say("items");
    say("1");
    say("2-5");
    expect(say("undo")[0]).toContain("redo Person 2");
    say("2");
    say("ok");
    expect(calls[0].participants.map((p) => p.itemIds)).toEqual([[1], [2]]);
  });

  it("cancel / stop end the session", () => {
    const { sm, say } = setup();
    sm.start("c1", receipt);
    expect(say("cancel")[0]).toContain("cancelled");
    expect(sm.hasSession("c1")).toBe(false);
    expect(say("3")).toEqual([]);

    sm.start("c1", receipt);
    say("2");
    say("items");
    expect(say("Stop")[0]).toContain("cancelled");
    expect(sm.hasSession("c1")).toBe(false);

    sm.start("c1", receipt);
    sm.cancel("c1");
    expect(sm.hasSession("c1")).toBe(false);
  });

  it("status and help work in every phase", () => {
    const { sm, say } = setup();
    sm.start("c1", receipt);
    expect(say("status")[0]).toContain("how many people");
    expect(say("help")[0]).toContain("how this works");
    say("2");
    expect(say("status")[0]).toContain("How do you want to split it?");
    say("items");
    say("Alex: 1");
    const st = say("status")[0];
    expect(st).toContain("Alex: 1");
    expect(st).toContain("Waiting on Person 2 (2 of 2)");
    say("2");
    expect(say("status")[0]).toContain("Who's paying");
    expect(say("help")[0]).toContain("assign 4 to 2");
  });

  it("sessions expire after ttl of inactivity", () => {
    const { sm, say, advance } = setup({ ttlMs: 1000 });
    sm.start("c1", receipt);
    advance(800);
    say("2"); // activity refreshes
    advance(800);
    expect(sm.hasSession("c1")).toBe(true);
    advance(300);
    expect(sm.hasSession("c1")).toBe(false);
    expect(say("1")).toEqual([]);
  });

  it("default ttl is 30 minutes and chit-chat does not refresh it", () => {
    const { sm, say, advance } = setup();
    sm.start("c1", receipt);
    say("2");
    say("items");
    advance(29 * 60 * 1000);
    expect(say("lol")).toEqual([]);
    advance(2 * 60 * 1000);
    expect(sm.hasSession("c1")).toBe(false);
  });

  it("starting again replaces the session and says so", () => {
    const { sm, say } = setup();
    sm.start("c1", receipt);
    say("3");
    say("items");
    say("1");
    const out = sm.start("c1", receipt, "Dana");
    expect(out[0]).toContain("Previous split discarded");
    expect(out[0]).toContain("Thanks Dana!");
    expect(say("2")[0]).toContain("Got it, 2 people");
  });

  it("keeps chats independent", () => {
    const { sm, say } = setup();
    sm.start("a", receipt);
    expect(say("2", "b")).toEqual([]);
    expect(say("2", "a")[0]).toContain("Got it");
    expect(sm.hasSession("b")).toBe(false);
  });

  it("keeps the session if calc throws", () => {
    const formatSummary: FormatSummary = () => "x";
    const calculateSplit: CalculateSplit = () => { throw new Error("boom"); };
    const sm = new SessionManager({ calculateSplit, formatSummary });
    sm.start("c", receipt);
    sm.handleText("c", "s", "1");
    sm.handleText("c", "s", "1-5");
    expect(sm.handleText("c", "s", "done")[0]).toContain("went wrong");
    expect(sm.hasSession("c")).toBe(true);
  });

  it("handles receipts without merchant and non-USD currency", () => {
    const { sm } = setup();
    const out = sm.start("c1", { ...receipt, merchant: undefined, currency: "EUR", tip: 2 });
    expect(out[0]).toContain("Receipt total €42.00");
    expect(out[0]).toContain("tip €2.00");
  });
});

describe("percent mode", () => {
  it("parseMode and parsePercents", async () => {
    const { parseMode, parsePercents } = await import("./parse.js");
    expect(parseMode("items")).toBe("items");
    expect(parseMode("Item-wise")).toBe("items");
    expect(parseMode("1")).toBe("items");
    expect(parseMode("percentage wise")).toBe("percent");
    expect(parseMode("2")).toBe("percent");
    expect(parseMode("%")).toBe("percent");
    expect(parseMode("even")).toBe("even");
    expect(parseMode("lol")).toBeNull();
    expect(parsePercents("50 30 20")?.percents).toEqual([50, 30, 20]);
    expect(parsePercents("50/50")?.percents).toEqual([50, 50]);
    expect(parsePercents("40%, 60%")?.percents).toEqual([40, 60]);
    expect(parsePercents("Alex 60, sam: 40")).toEqual({ percents: [60, 40], names: ["Alex", "Sam"] });
    expect(parsePercents("33.3 33.3 33.4")?.percents).toEqual([33.3, 33.3, 33.4]);
    expect(parsePercents("see you at 7")).toBeNull();
    expect(parsePercents("hello")).toBeNull();
  });

  it("splits by percentages with names and a payer", () => {
    const { sm, say, calls } = setup();
    sm.start("c1", receipt);
    say("3");
    expect(say("percent")[0]).toContain("add up to 100");
    const r = say("Alex 50, Sam 30, Jo 20");
    expect(r[0]).toContain("Alex: 50% ≈ $21.00");
    expect(r[0]).toContain("Who's paying");
    expect(say("2")).toEqual(["SUMMARY payer=Sam"]);
    expect(calls[0].percentages).toEqual([50, 30, 20]);
    expect(calls[0].participants.map((p) => p.label)).toEqual(["Alex", "Sam", "Jo"]);
    expect(calls[0].participants.every((p) => p.itemIds.length === 0)).toBe(true);
  });

  it("accepts percentages or 'even' directly at the mode question", () => {
    const a = setup();
    a.sm.start("c1", receipt);
    a.say("2");
    expect(a.say("70 30")[0]).toContain("Splitting by percentage");
    a.say("done");
    expect(a.calls[0].percentages).toEqual([70, 30]);

    const b = setup();
    b.sm.start("c1", receipt);
    b.say("3");
    expect(b.say("even")[0]).toContain("33.3%");
    b.say("done");
    expect(b.calls[0].percentages).toHaveLength(3);
  });

  it("rejects wrong count or total and stays quiet on chit-chat", () => {
    const { sm, say } = setup();
    sm.start("c1", receipt);
    say("3");
    say("percentage");
    expect(say("50 50")[0]).toContain("I need 3 percentages");
    expect(say("50 30 30")[0]).toContain("add up to 110%");
    expect(say("lol ok")).toEqual([]);
    expect(say("split evenly")[0]).toContain("Splitting by percentage");
  });

  it("undo steps back through percent mode", () => {
    const { sm, say } = setup();
    sm.start("c1", receipt);
    say("2");
    say("percent");
    say("60 40");
    expect(say("undo")[0]).toContain("redo the percentages");
    expect(say("undo")[0]).toContain("How do you want to split it?");
    expect(say("undo")[0]).toContain("How many people");
  });
});
