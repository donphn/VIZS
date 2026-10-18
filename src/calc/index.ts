import type {
  CalculateSplit,
  FormatSummary,
  PersonShare,
  ReceiptItem,
  SplitResult,
} from "../types.js";

// ---------- integer-cent helpers ----------

const toCents = (x: number): number => (Number.isFinite(x) ? Math.round(x * 100) : 0);
const fromCents = (c: number): number => c / 100;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * Largest-remainder allocation: split `total` cents across `weights` so the
 * parts sum to exactly `total`. Leftover pennies go to the largest fractional
 * remainders; ties are broken deterministically, starting at index
 * `tieOffset` (mod n) and walking forward, so repeated even splits don't
 * always favor the same person.
 *
 * If the weights are unusable (all zero, any negative, non-finite), the split
 * is even. Negative totals (discounts) are allocated by magnitude then negated.
 */
export function allocate(total: number, weights: number[], tieOffset = 0): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (total < 0) return allocate(-total, weights, tieOffset).map((x) => (x === 0 ? 0 : -x));
  const usable = weights.every((w) => Number.isFinite(w) && w >= 0) && sum(weights) > 0;
  const w = usable ? weights : weights.map(() => 1);
  const wSum = sum(w);
  const base: number[] = [];
  const rem: number[] = [];
  for (let i = 0; i < n; i++) {
    const exact = (total * w[i]!) / wSum;
    const floor = Math.floor(exact);
    base.push(floor);
    rem.push(exact - floor);
  }
  let left = total - sum(base);
  const off = ((tieOffset % n) + n) % n;
  const order = [...Array(n).keys()].sort((a, b) => {
    const d = rem[b]! - rem[a]!;
    if (Math.abs(d) > 1e-9) return d;
    return ((a - off + n) % n) - ((b - off + n) % n);
  });
  for (let k = 0; left > 0; k = (k + 1) % n, left--) base[order[k]!]! += 1;
  return base;
}

// ---------- calculateSplit ----------

export const calculateSplit: CalculateSplit = (req) => {
  const { receipt, participants } = req;
  const n = participants.length;
  const payerIndex =
    req.payerIndex !== undefined && req.payerIndex >= 0 && req.payerIndex < n ? req.payerIndex : 0;

  const itemCents: { id: number; name: string; amount: number }[][] = participants.map(() => []);
  const unclaimed: ReceiptItem[] = [];
  const claimSets = participants.map((p) => new Set(p.itemIds));

  receipt.items.forEach((item, idx) => {
    const cents = toCents(item.price);
    let claimants = claimSets.flatMap((s, i) => (s.has(item.id) ? [i] : []));
    if (claimants.length === 0) {
      unclaimed.push(item);
      claimants = [...Array(n).keys()]; // split evenly across everyone
    }
    if (claimants.length === 0) return; // no participants at all
    const parts = allocate(cents, claimants.map(() => 1), idx);
    claimants.forEach((pi, k) => {
      itemCents[pi]!.push({ id: item.id, name: item.name, amount: parts[k]! });
    });
  });

  const subtotals = itemCents.map((xs) => sum(xs.map((x) => x.amount)));

  // Tax and tip are allocated proportionally to each person's item subtotal
  // (allocate() falls back to an even split when everyone's subtotal is 0).
  const taxCents = toCents(receipt.tax);
  let tipCents = 0;
  let tipFromRate = false;
  if (receipt.tip > 0) {
    tipCents = toCents(receipt.tip);
  } else if (req.tipRate !== undefined && req.tipRate > 0) {
    const base = receipt.subtotal > 0 ? toCents(receipt.subtotal) : sum(subtotals);
    tipCents = Math.round(base * req.tipRate);
    tipFromRate = true;
  }
  const taxes = allocate(taxCents, subtotals);
  const tips = allocate(tipCents, subtotals);

  // Reconciliation to the receipt.
  // The item prices often don't sum exactly to receipt.subtotal (OCR noise,
  // un-itemized discounts or fees), so the tax/tip split above is based on the
  // claimed item amounts. If receipt.total is present, we then distribute any
  // difference between the sum of all shares and what the restaurant actually
  // charges, proportionally to each person's pre-adjustment total, so the
  // shares sum to receipt.total. When the tip comes from a tipRate override
  // (receipt.tip was 0, so receipt.total excludes it), the target is
  // receipt.total + the computed tip. The adjustment is reflected only in
  // PersonShare.total, so total = itemsSubtotal + tax + tip + adjustment;
  // formatSummary shows any nonzero adjustment explicitly.
  const preTotals = subtotals.map((s, i) => s + taxes[i]! + tips[i]!);
  let adjustments = preTotals.map(() => 0);
  const totalCents = toCents(receipt.total);
  if (n > 0 && totalCents > 0) {
    const target = totalCents + (tipFromRate ? tipCents : 0);
    const diff = target - sum(preTotals);
    // A large gap almost always means the total was misread, not real fees.
    // Skip the adjustment then; formatSummary flags the mismatch instead.
    if (diff !== 0 && Math.abs(diff) <= maxAdjustmentCents(sum(preTotals))) {
      adjustments = allocate(diff, preTotals);
    }
  }
  const totals = preTotals.map((t, i) => t + adjustments[i]!);

  const shares: PersonShare[] = participants.map((p, i) => ({
    label: p.label,
    items: itemCents[i]!.map((x) => ({ ...x, amount: fromCents(x.amount) })),
    itemsSubtotal: fromCents(subtotals[i]!),
    tax: fromCents(taxes[i]!),
    tip: fromCents(tips[i]!),
    total: fromCents(totals[i]!),
  }));

  const payerLabel = participants[payerIndex]?.label ?? "";
  const settlements = participants.flatMap((p, i) =>
    i !== payerIndex && totals[i]! > 0
      ? [{ from: p.label, to: payerLabel, amount: fromCents(totals[i]!) }]
      : [],
  );

  return {
    shares,
    unclaimed,
    payerLabel,
    grandTotal: fromCents(sum(totals)),
    settlements,
  };
};

// ---------- formatSummary ----------

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

export function formatMoney(amount: number, currency = "USD"): string {
  const code = (currency || "USD").toUpperCase();
  const cents = toCents(amount);
  const sign = cents < 0 ? "-" : "";
  const body = (Math.abs(cents) / 100).toFixed(2);
  const sym = SYMBOLS[code];
  return sym ? `${sign}${sym}${body}` : `${sign}${code} ${body}`;
}

const FRACTIONS: Record<number, string> = { 2: "½", 3: "⅓", 4: "¼", 5: "⅕", 6: "⅙", 8: "⅛" };
const fraction = (n: number): string => FRACTIONS[n] ?? `1/${n}`;

/** Largest receipt-total adjustment we trust: 5% of the computed total, at least $5. */
function maxAdjustmentCents(computedCents: number): number {
  return Math.max(500, Math.round(computedCents * 0.05));
}

/** Tip added on top of the printed total (tipRate override), in cents. */
function sumTips(result: SplitResult): number {
  return sum(result.shares.map((s) => toCents(s.tip)));
}

export const formatSummary: FormatSummary = (result, receipt) => {
  const m = (x: number) => formatMoney(x, receipt.currency);
  const lines: string[] = [];
  const title = receipt.merchant?.trim() ? `Split for ${receipt.merchant.trim()}` : "Split";
  lines.push(`🧾 ${title} — total ${m(result.grandTotal)}`, "");

  // How many people share each item (derived from the result itself).
  const shareCount = new Map<number, number>();
  for (const s of result.shares) {
    for (const id of new Set(s.items.map((it) => it.id))) {
      shareCount.set(id, (shareCount.get(id) ?? 0) + 1);
    }
  }

  for (const s of result.shares) {
    lines.push(`${s.label} — ${m(s.total)}`);
    if (s.items.length === 0) lines.push("  (no items)");
    for (const it of s.items) {
      const k = shareCount.get(it.id) ?? 1;
      const frac = k > 1 ? ` (${fraction(k)})` : "";
      lines.push(`  • ${it.name}${frac} ${m(it.amount)}`);
    }
    const extras: string[] = [];
    if (toCents(s.tax) !== 0) extras.push(`tax ${m(s.tax)}`);
    if (toCents(s.tip) !== 0) extras.push(`tip ${m(s.tip)}`);
    const adj = toCents(s.total) - toCents(s.itemsSubtotal) - toCents(s.tax) - toCents(s.tip);
    if (adj !== 0) extras.push(`adj ${adj > 0 ? "+" : ""}${m(fromCents(adj))}`);
    if (extras.length) lines.push(`  + ${extras.join(" · ")}`);
  }

  if (result.unclaimed.length) {
    lines.push(`⚠️ Unclaimed (split evenly): ${result.unclaimed.map((i) => i.name).join(", ")}`);
  }
  const expectedCents = toCents(receipt.total) + (toCents(receipt.tip) > 0 ? 0 : sumTips(result));
  if (toCents(receipt.total) > 0 && expectedCents !== toCents(result.grandTotal)) {
    lines.push(`⚠️ Receipt total reads ${m(fromCents(expectedCents))}, but the items add up to ${m(result.grandTotal)}. Double-check the receipt.`);
  }
  if (result.payerLabel) {
    lines.push(`💳 ${result.payerLabel} pays the restaurant ${m(result.grandTotal)}.`);
  }
  if (result.settlements.length) {
    lines.push(`Venmo ${result.payerLabel}:`);
    for (const st of result.settlements) lines.push(`  • ${st.from} → ${m(st.amount)}`);
  }
  return lines.join("\n");
};
