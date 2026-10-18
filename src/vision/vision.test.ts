import { describe, expect, it } from "vitest";
import { normalizeReceipt, parseJsonLoose, toNumber } from "./index.js";

describe("toNumber", () => {
  it("coerces currency strings", () => {
    expect(toNumber("$12.50")).toBe(12.5);
    expect(toNumber("1,234.00")).toBe(1234);
    expect(toNumber("-$3")).toBe(-3);
    expect(toNumber("(2.00)")).toBe(-2);
    expect(toNumber("2.00-")).toBe(-2);
    expect(toNumber(7)).toBe(7);
    expect(toNumber("abc")).toBeUndefined();
    expect(toNumber(null)).toBeUndefined();
  });
});

describe("parseJsonLoose", () => {
  it("handles ```json fences and surrounding prose", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here you go: {"a":2} thanks')).toEqual({ a: 2 });
    expect(parseJsonLoose("nope")).toBeUndefined();
  });
});

describe("normalizeReceipt", () => {
  it("normalizes a typical receipt", () => {
    const r = normalizeReceipt({
      is_receipt: true,
      merchant: " Joe's Diner ",
      currency: "usd",
      items: [
        { name: "Burger", price: "$12.50", quantity: 1 },
        { name: "Fries", price: 4, quantity: "2" },
        { name: "Soda", price: "2.999" },
      ],
      subtotal: "19.50",
      tax: "1.73",
      tip: null,
      total: "21.23",
    });
    expect(r).toEqual({
      merchant: "Joe's Diner",
      currency: "USD",
      items: [
        { id: 1, name: "Burger", price: 12.5, quantity: 1 },
        { id: 2, name: "Fries", price: 4, quantity: 2 },
        { id: 3, name: "Soda", price: 3, quantity: 1 },
      ],
      subtotal: 19.5,
      tax: 1.73,
      tip: 0,
      total: 21.23,
    });
  });

  it("returns null for non-receipts or no items", () => {
    expect(normalizeReceipt({ is_receipt: false, items: [{ name: "x", price: 1 }] })).toBeNull();
    expect(normalizeReceipt({ is_receipt: true, items: [] })).toBeNull();
    expect(normalizeReceipt({ is_receipt: true })).toBeNull();
    expect(normalizeReceipt(null)).toBeNull();
    expect(normalizeReceipt("garbage")).toBeNull();
    expect(normalizeReceipt({ is_receipt: true, items: [{ name: "Free water", price: 0 }] })).toBeNull();
  });

  it("accepts a fenced JSON string", () => {
    const r = normalizeReceipt('```json\n{"is_receipt":true,"items":[{"name":"Tea","price":3}],"total":3}\n```');
    expect(r?.items).toEqual([{ id: 1, name: "Tea", price: 3, quantity: 1 }]);
    expect(r?.currency).toBe("USD");
    expect(r?.merchant).toBeUndefined();
  });

  it("computes subtotal from items and total when missing", () => {
    const r = normalizeReceipt({
      is_receipt: true,
      items: [
        { name: "A", price: 10 },
        { name: "B", price: 5.255 },
      ],
      tax: 1.2,
    });
    expect(r?.subtotal).toBe(15.26);
    expect(r?.tip).toBe(0);
    expect(r?.total).toBe(16.46);
  });

  it("infers tip from total - subtotal - tax", () => {
    const r = normalizeReceipt({
      is_receipt: true,
      items: [{ name: "Pasta", price: 20 }],
      subtotal: 20,
      tax: 2,
      total: 26,
    });
    expect(r?.tip).toBe(4);
    expect(r?.total).toBe(26);
  });

  it("does not infer tip from rounding noise or when tip is present", () => {
    const noisy = normalizeReceipt({
      is_receipt: true,
      items: [{ name: "Pasta", price: 20 }],
      subtotal: 20,
      tax: 2,
      total: 22.01,
    });
    expect(noisy?.tip).toBe(0);
    const given = normalizeReceipt({
      is_receipt: true,
      items: [{ name: "Pasta", price: 20 }],
      subtotal: 20,
      tax: 2,
      tip: 3,
      total: 26,
    });
    expect(given?.tip).toBe(3);
  });

  it("drops zero lines and non-item lines that slipped into items", () => {
    const r = normalizeReceipt({
      is_receipt: true,
      items: [
        { name: "Salad", price: 9 },
        { name: "Extra napkins", price: 0 },
        { name: "Subtotal", price: 9 },
        { name: "Tax", price: 0.8 },
        { name: "Total", price: 9.8 },
      ],
    });
    expect(r?.items).toEqual([{ id: 1, name: "Salad", price: 9, quantity: 1 }]);
    expect(r?.subtotal).toBe(9);
  });

  it("applies an item discount to the preceding item", () => {
    const r = normalizeReceipt({
      is_receipt: true,
      items: [
        { name: "Wine", price: 40 },
        { name: "Happy hour", price: -10 },
        { name: "Bread", price: 5 },
      ],
    });
    expect(r?.items).toEqual([
      { id: 1, name: "Wine", price: 30, quantity: 1 },
      { id: 2, name: "Bread", price: 5, quantity: 1 },
    ]);
    expect(r?.subtotal).toBe(35);
  });

  it("spreads a large/leading discount proportionally", () => {
    const r = normalizeReceipt({
      is_receipt: true,
      items: [
        { name: "Coupon", price: "-$6.00" },
        { name: "A", price: 20 },
        { name: "B", price: 10 },
      ],
    });
    expect(r?.items.map((i) => i.price)).toEqual([16, 8]);
    expect(r?.items.map((i) => i.id)).toEqual([1, 2]);
    expect(r?.subtotal).toBe(24);
  });

  it("defaults bad quantity and currency", () => {
    const r = normalizeReceipt({
      is_receipt: true,
      currency: "dollars",
      items: [{ name: "X", price: 1, quantity: 0 }],
    });
    expect(r?.items[0].quantity).toBe(1);
    expect(r?.currency).toBe("USD");
  });
});
