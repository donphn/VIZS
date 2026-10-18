import { describe, expect, it } from "vitest";
import { allocate, calculateSplit, formatMoney, formatSummary } from "./index.js";
import type { Receipt, SplitRequest } from "../types.js";

const cents = (x: number) => Math.round(x * 100);
const sumCents = (xs: number[]) => xs.reduce((a, x) => a + cents(x), 0);

function receipt(partial: Partial<Receipt> & { items: Receipt["items"] }): Receipt {
  const subtotal = partial.subtotal ?? partial.items.reduce((a, i) => a + i.price, 0);
  const tax = partial.tax ?? 0;
  const tip = partial.tip ?? 0;
  return {
    currency: "USD",
    subtotal,
    tax,
    tip,
    total: partial.total ?? Math.round((subtotal + tax + tip) * 100) / 100,
    ...partial,
  };
}

const item = (id: number, name: string, price: number) => ({ id, name, price, quantity: 1 });

/** Every share's parts and totals must be internally consistent and sum exactly. */
function checkInvariants(req: SplitRequest) {
  const r = calculateSplit(req);
  const totalTax = sumCents(r.shares.map((s) => s.tax));
  const totalTip = sumCents(r.shares.map((s) => s.tip));
  const totalItems = sumCents(r.shares.map((s) => s.itemsSubtotal));
  expect(totalTax).toBe(cents(req.receipt.tax));
  expect(totalItems).toBe(sumCents(req.receipt.items.map((i) => i.price)));
  for (const s of r.shares) {
    expect(cents(s.itemsSubtotal)).toBe(sumCents(s.items.map((i) => i.amount)));
    // every amount is a whole number of cents
    for (const v of [s.total, s.tax, s.tip, s.itemsSubtotal]) {
      expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6);
    }
  }
  expect(cents(r.grandTotal)).toBe(sumCents(r.shares.map((s) => s.total)));
  return { r, totalTip };
}

describe("allocate", () => {
  it("sums exactly and distributes pennies deterministically", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(100, [1, 1, 1], 1)).toEqual([33, 34, 33]);
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocate(10, [0, 0])).toEqual([5, 5]);
    expect(allocate(7, [3, 1])).toEqual([5, 2]);
  });
});

describe("calculateSplit", () => {
  it("does a basic proportional split", () => {
    const rc = receipt({ items: [item(1, "Steak", 30), item(2, "Salad", 10)], tax: 4, tip: 8 });
    const r = calculateSplit({
      receipt: rc,
      participants: [
        { label: "A", itemIds: [1] },
        { label: "B", itemIds: [2] },
      ],
    });
    expect(r.shares[0]).toMatchObject({ itemsSubtotal: 30, tax: 3, tip: 6, total: 39 });
    expect(r.shares[1]).toMatchObject({ itemsSubtotal: 10, tax: 1, tip: 2, total: 13 });
    expect(r.grandTotal).toBe(52);
    expect(r.payerLabel).toBe("A");
    expect(r.settlements).toEqual([{ from: "B", to: "A", amount: 13 }]);
    expect(r.unclaimed).toEqual([]);
  });

  it("splits shared items N ways with exact pennies", () => {
    const rc = receipt({ items: [item(1, "Nachos", 10), item(2, "Beer", 6)] });
    const r = calculateSplit({
      receipt: rc,
      participants: [
        { label: "A", itemIds: [1, 2] },
        { label: "B", itemIds: [1] },
        { label: "C", itemIds: [1] },
      ],
    });
    const nachos = r.shares.map((s) => s.items.find((i) => i.id === 1)!.amount);
    expect(sumCents(nachos)).toBe(1000);
    expect(nachos.sort()).toEqual([3.33, 3.33, 3.34]);
    expect(r.grandTotal).toBe(16);
  });

  it("splits unclaimed items across everyone and reports them", () => {
    const rc = receipt({ items: [item(1, "Burger", 12), item(2, "Soda", 3)], tax: 1.5 });
    const r = calculateSplit({
      receipt: rc,
      participants: [
        { label: "A", itemIds: [1] },
        { label: "B", itemIds: [] },
        { label: "C", itemIds: [] },
      ],
    });
    expect(r.unclaimed.map((i) => i.name)).toEqual(["Soda"]);
    expect(r.shares.map((s) => s.itemsSubtotal)).toEqual([13, 1, 1]);
    expect(cents(r.grandTotal)).toBe(1650);
    checkInvariants({ receipt: rc, participants: [{ label: "A", itemIds: [1] }, { label: "B", itemIds: [] }, { label: "C", itemIds: [] }] });
  });

  it("uses tipRate only when receipt.tip is 0, and reconciles to total + tip", () => {
    const rc = receipt({ items: [item(1, "X", 40), item(2, "Y", 60)], tax: 8 });
    const parts = [
      { label: "A", itemIds: [1] },
      { label: "B", itemIds: [2] },
    ];
    const r = calculateSplit({ receipt: rc, participants: parts, tipRate: 0.2 });
    expect(r.shares.map((s) => s.tip)).toEqual([8, 12]);
    expect(r.grandTotal).toBe(128);

    const withTip = calculateSplit({ receipt: { ...rc, tip: 10, total: 118 }, participants: parts, tipRate: 0.2 });
    expect(sumCents(withTip.shares.map((s) => s.tip))).toBe(1000);
    expect(withTip.grandTotal).toBe(118);
  });

  it("reconciles shares to receipt.total when items don't match subtotal", () => {
    // Items sum to 50 but the receipt has an un-itemized $5 discount.
    const rc = receipt({ items: [item(1, "A", 20), item(2, "B", 30)], subtotal: 45, tax: 4.5, total: 49.5 });
    const r = calculateSplit({
      receipt: rc,
      participants: [
        { label: "P1", itemIds: [1] },
        { label: "P2", itemIds: [2] },
      ],
    });
    expect(r.grandTotal).toBe(49.5);
    expect(sumCents(r.shares.map((s) => s.total))).toBe(4950);
    // proportional: P1 had 40% of pre-adjustment totals
    expect(r.shares[0]!.total).toBeCloseTo(19.8, 2);
    expect(r.shares[1]!.total).toBeCloseTo(29.7, 2);
  });

  it("handles a single participant", () => {
    const rc = receipt({ items: [item(1, "Pho", 14.25)], tax: 1.27, tip: 3 });
    const r = calculateSplit({ receipt: rc, participants: [{ label: "Solo", itemIds: [] }] });
    expect(r.shares[0]!.total).toBe(18.52);
    expect(r.unclaimed).toHaveLength(1);
    expect(r.settlements).toEqual([]);
  });

  it("splits tax/tip evenly when nobody has a subtotal", () => {
    const rc = receipt({ items: [], subtotal: 0, tax: 1, tip: 2, total: 3 });
    const r = calculateSplit({
      receipt: rc,
      participants: [
        { label: "A", itemIds: [] },
        { label: "B", itemIds: [] },
        { label: "C", itemIds: [] },
      ],
    });
    expect(sumCents(r.shares.map((s) => s.tax))).toBe(100);
    expect(sumCents(r.shares.map((s) => s.tip))).toBe(200);
    expect(r.grandTotal).toBe(3);
  });

  it("gives a participant with no items 0 when everything is claimed", () => {
    const rc = receipt({ items: [item(1, "A", 10)], tax: 1 });
    const r = calculateSplit({
      receipt: rc,
      participants: [
        { label: "A", itemIds: [1] },
        { label: "B", itemIds: [] },
      ],
      payerIndex: 1,
    });
    expect(r.shares[1]!.total).toBe(0);
    expect(r.payerLabel).toBe("B");
    expect(r.settlements).toEqual([{ from: "A", to: "B", amount: 11 }]);
  });

  it("keeps exact penny sums across random receipts (property-style)", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 200; trial++) {
      const nItems = Math.floor(rand() * 8);
      const items = Array.from({ length: nItems }, (_, i) => item(i + 1, `I${i + 1}`, Math.round(rand() * 5000) / 100));
      const itemsSum = items.reduce((a, i) => a + cents(i.price), 0);
      const tax = Math.round(itemsSum * 0.0875) / 100;
      const tip = rand() < 0.5 ? Math.round(rand() * 2000) / 100 : 0;
      const noise = Math.floor(rand() * 7) - 3; // OCR-ish cents of drift
      const total = rand() < 0.8 ? (itemsSum + cents(tax) + cents(tip) + noise) / 100 : 0;
      const nPeople = 1 + Math.floor(rand() * 5);
      const participants = Array.from({ length: nPeople }, (_, p) => ({
        label: `P${p + 1}`,
        itemIds: items.filter(() => rand() < 0.4).map((i) => i.id),
      }));
      const tipRate = rand() < 0.3 ? 0.18 : undefined;
      const rc = receipt({ items, tax, tip, total });
      const req = { receipt: rc, participants, tipRate };
      const { r, totalTip } = checkInvariants(req);
      const expectedTip = tip > 0 ? cents(tip) : tipRate ? Math.round(cents(rc.subtotal) * tipRate) : 0;
      expect(totalTip).toBe(expectedTip);
      if (total > 0) {
        const target = cents(total) + (tip === 0 && tipRate ? expectedTip : 0);
        expect(cents(r.grandTotal)).toBe(target);
      } else {
        expect(cents(r.grandTotal)).toBe(itemsSum + cents(tax) + expectedTip);
      }
      const settled = r.settlements.reduce((a, s) => a + cents(s.amount), 0);
      const owed = r.shares.slice(1).filter((s) => s.total > 0).reduce((a, s) => a + cents(s.total), 0);
      expect(settled).toBe(owed);
    }
  });
});

describe("formatSummary", () => {
  it("renders the key lines", () => {
    const rc = receipt({
      merchant: "Joe's Diner",
      items: [item(1, "Burger", 14), item(2, "Fries", 6), item(3, "Soda", 3)],
      tax: 2.07,
      tip: 4.6,
    });
    const r = calculateSplit({
      receipt: rc,
      participants: [
        { label: "Alex", itemIds: [1, 2] },
        { label: "Person 2", itemIds: [2] },
        { label: "Person 3", itemIds: [] },
      ],
    });
    const out = formatSummary(r, rc);
    expect(out).toContain(`🧾 Split for Joe's Diner — total $${r.grandTotal.toFixed(2)}`);
    expect(out).toMatch(/^Alex — \$\d+\.\d\d$/m);
    expect(out).toContain("  • Burger $14.00");
    expect(out).toContain("  • Fries (½) $3.00");
    expect(out).toContain("  • Soda (⅓) $1.00");
    expect(out).toMatch(/^ {2}\+ tax \$\d+\.\d\d · tip \$\d+\.\d\d$/m);
    expect(out).toContain("⚠️ Unclaimed (split evenly): Soda");
    expect(out).toContain(`💳 Alex pays the restaurant $${r.grandTotal.toFixed(2)}.`);
    expect(out).toContain("Venmo Alex:");
    expect(out).toContain(`  • Person 2 → $${r.shares[1]!.total.toFixed(2)}`);
    expect(out).not.toMatch(/\|/); // no markdown tables
  });

  it("uses currency symbols and shows adjustments", () => {
    expect(formatMoney(5, "EUR")).toBe("€5.00");
    expect(formatMoney(5, "GBP")).toBe("£5.00");
    expect(formatMoney(5, "JPY")).toBe("JPY 5.00");
    expect(formatMoney(-1.5, "USD")).toBe("-$1.50");
    const rc = receipt({ currency: "EUR", items: [item(1, "Wine", 20)], total: 19 });
    const out = formatSummary(calculateSplit({ receipt: rc, participants: [{ label: "Solo", itemIds: [1] }] }), rc);
    expect(out).toContain("🧾 Split — total €19.00");
    expect(out).toContain("adj -€1.00");
    expect(out).not.toContain("Venmo");
  });
});
