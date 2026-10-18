import type { AnalyzeReceipt, ImageInput, Receipt, ReceiptAnalysis, ReceiptItem } from "../types.js";
import { DEFAULT_GROK_MODEL, grokChat, type GrokMessage } from "./grok.js";

export { grokChat, GrokError } from "./grok.js";
export type { GrokMessage, GrokChatOptions, GrokContentPart } from "./grok.js";

const SYSTEM_PROMPT = `You extract structured data from photos of purchase receipts (restaurants, bars, stores).
Respond with ONE JSON object and nothing else, using exactly this shape:
{
  "is_receipt": boolean,
  "readable": boolean,           // false if it IS a receipt but items/prices can't be read reliably
  "unreadable_reason": string | null, // short, e.g. "too blurry", "items cut off", "too dark"
  "merchant": string | null,
  "currency": string,            // ISO 4217 code, e.g. "USD"
  "items": [{ "name": string, "price": number, "quantity": number }],
  "subtotal": number | null,
  "tax": number | null,
  "tip": number | null,
  "total": number | null
}
Rules:
- If the image is not a receipt at all, return {"is_receipt": false, "readable": false, "items": []}.
- If it IS a receipt but too blurry, dark, cropped or crumpled to read the items and prices reliably, return {"is_receipt": true, "readable": false, "unreadable_reason": "<short reason>", "items": []}. Do not guess prices.
- "price" is the LINE TOTAL for that line (already multiplied by quantity), not the unit price.
- List every purchased line item in printed order. Do NOT include subtotal, tax, tip, total, payment, change or balance lines as items.
- Discounts/comps/coupons: include them as items with a NEGATIVE price, placed right after the item they apply to.
- "tip" covers tip, gratuity and service charges. Use null if none is printed. If a tip was handwritten, use it.
- If a total was handwritten (after tip), use that as "total".
- Numbers must be plain numbers without currency symbols. Use null for anything not printed.`;

const USER_PROMPT = "Extract this receipt as JSON.";

function imageUrl(image: ImageInput): string {
  if (image.kind === "url") return image.url;
  // HEIC/HEIF: we just pass the mimeType through. xAI documents only JPEG/PNG
  // support, so if Grok rejects HEIC images the photon layer should convert
  // them to JPEG before calling analyzeReceipt.
  const data = image.data.replace(/^data:[^,]*,/, "");
  return `data:${image.mimeType || "image/jpeg"};base64,${data}`;
}

/** Calls Grok vision on the image and classifies it as a readable receipt, unreadable receipt, or other photo. */
export const analyzeReceipt: AnalyzeReceipt = async (image) => {
  const messages: GrokMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: imageUrl(image), detail: "high" } },
        { type: "text", text: USER_PROMPT },
      ],
    },
  ];
  const text = await grokChat(messages, {
    model: process.env.GROK_VISION_MODEL || DEFAULT_GROK_MODEL,
    json: true,
    temperature: 0,
  });
  return classifyReceipt(parseJsonLoose(text));
};

/**
 * Turn Grok's raw JSON into a ReceiptAnalysis (pure, network-free).
 * A receipt we can't extract any items from counts as unreadable, even if Grok said readable.
 * Garbage output is treated as not_receipt so random photos never make the bot speak.
 */
export function classifyReceipt(raw: unknown): ReceiptAnalysis {
  if (typeof raw === "string") raw = parseJsonLoose(raw);
  if (!isRecord(raw) || raw.is_receipt !== true) return { status: "not_receipt" };
  const reason =
    typeof raw.unreadable_reason === "string" && raw.unreadable_reason.trim()
      ? raw.unreadable_reason.trim()
      : undefined;
  if (raw.readable === false) return { status: "unreadable", reason };
  const receipt = normalizeReceipt(raw);
  return receipt ? { status: "ok", receipt } : { status: "unreadable", reason };
}

/** Parse JSON tolerant of ```json fences and surrounding prose. Returns undefined on failure. */
export function parseJsonLoose(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Normalization (pure, network-free)
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Coerce "$1,234.50", "(2.00)", "-$3", 12 → number. Returns undefined if not numeric. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  let s = v.trim();
  if (!s) return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s,]/g, "").replace(/[$€£¥₹]|[A-Za-z]{3}$|^[A-Za-z]{3}/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.endsWith("-")) {
    // some POS print trailing minus: "2.00-"
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^\d*\.?\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : undefined;
}

const NON_ITEM_NAME =
  /^\s*(sub\s*-?\s*total|total|tax|sales tax|vat|gst|hst|tip|gratuity|service charge|change|cash|balance( due)?|amount due|visa|mastercard|amex|card|payment)\b/i;

interface RawLine {
  name: string;
  price: number;
  quantity: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Apply negative (discount) lines. A discount directly after an item that is
 * larger than the discount is applied to that item; otherwise it's spread
 * proportionally across all positive items so the item sum stays correct.
 */
function applyDiscounts(lines: RawLine[]): RawLine[] {
  const out: RawLine[] = [];
  const pending: number[] = [];
  for (const line of lines) {
    if (line.price > 0) {
      out.push({ ...line });
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.price + line.price > 0) prev.price = prev.price + line.price;
    else pending.push(line.price);
  }
  const extra = pending.reduce((a, b) => a + b, 0);
  const sum = out.reduce((a, l) => a + l.price, 0);
  if (extra < 0 && sum + extra > 0) {
    const factor = (sum + extra) / sum;
    for (const l of out) l.price = l.price * factor;
  }
  return out;
}

/**
 * Validate and normalize Grok's raw JSON into a Receipt.
 * Returns null if it isn't a receipt or has no usable items.
 */
export function normalizeReceipt(raw: unknown): Receipt | null {
  if (typeof raw === "string") raw = parseJsonLoose(raw);
  if (!isRecord(raw)) return null;
  if (raw.is_receipt === false || raw.is_receipt === "false") return null;
  if (!Array.isArray(raw.items) || raw.items.length === 0) return null;

  const lines: RawLine[] = [];
  for (const it of raw.items) {
    if (!isRecord(it)) continue;
    const name = typeof it.name === "string" ? it.name.trim() : String(it.name ?? "").trim();
    const price = toNumber(it.price ?? it.total ?? it.amount);
    if (price === undefined || price === 0) continue;
    let quantity = toNumber(it.quantity ?? it.qty);
    if (quantity === undefined || quantity <= 0) quantity = 1;
    if (price > 0 && NON_ITEM_NAME.test(name)) continue;
    lines.push({ name: name || "Item", price, quantity });
  }

  const merged = applyDiscounts(lines);
  if (merged.length === 0) return null;

  const items: ReceiptItem[] = merged.map((l, i) => ({
    id: i + 1,
    name: l.name,
    price: round2(l.price),
    quantity: l.quantity,
  }));
  const itemsSum = round2(items.reduce((a, it) => a + it.price, 0));

  const pos = (v: unknown) => {
    const n = toNumber(v);
    return n !== undefined && n > 0 ? round2(n) : undefined;
  };

  const subtotal = pos(raw.subtotal) ?? itemsSum;
  const tax = pos(raw.tax) ?? 0;
  let tip = pos(raw.tip ?? raw.gratuity ?? raw.service_charge) ?? 0;
  let total = pos(raw.total);

  if (total !== undefined && tip === 0) {
    const inferred = round2(total - subtotal - tax);
    if (inferred > 0.01) tip = inferred;
  }
  if (total === undefined) total = round2(subtotal + tax + tip);

  const currencyRaw = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
  const currency = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : "USD";
  const merchant =
    typeof raw.merchant === "string" && raw.merchant.trim() ? raw.merchant.trim() : undefined;

  const receipt: Receipt = { currency, items, subtotal, tax, tip, total };
  if (merchant) receipt.merchant = merchant;
  return receipt;
}
