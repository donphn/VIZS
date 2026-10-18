/**
 * Shared contracts between modules. Every worktree builds against these.
 * Changing this file requires coordinating across vision/session/calc/photon.
 */

// ---------- Receipt (produced by vision, consumed by session + calc) ----------

export interface ReceiptItem {
  /** 1-based index, stable for the life of a session. Users claim by this number. */
  id: number;
  name: string;
  /** Line total in currency units (e.g. 12.5 = $12.50), already multiplied by quantity. */
  price: number;
  quantity: number;
}

export interface Receipt {
  merchant?: string;
  currency: string; // ISO code, default "USD"
  items: ReceiptItem[];
  subtotal: number;
  tax: number;
  /** Tip / gratuity / service charge printed on the receipt. 0 if none. */
  tip: number;
  total: number;
}

/** Input image handed from the Photon layer to vision. */
export type ImageInput =
  | { kind: "base64"; data: string; mimeType: string }
  | { kind: "url"; url: string };

/**
 * vision result:
 * - ok: parsed receipt, ready to split
 * - unreadable: it's a receipt, but too blurry/cropped/dark to extract items (tell the group)
 * - not_receipt: any other photo (stay silent)
 */
export type ReceiptAnalysis =
  | { status: "ok"; receipt: Receipt }
  | { status: "unreadable"; reason?: string }
  | { status: "not_receipt" };

export type AnalyzeReceipt = (image: ImageInput) => Promise<ReceiptAnalysis>;

// ---------- Split (produced by session, consumed by calc) ----------

export interface Participant {
  /** Display label, e.g. "Person 1" or a name the person typed. */
  label: string;
  /** Item ids this person claimed. An item claimed by N people is split N ways. */
  itemIds: number[];
}

export interface SplitRequest {
  receipt: Receipt;
  participants: Participant[];
  /** Index into participants of who pays the restaurant (defaults to 0). */
  payerIndex?: number;
  /** Optional tip override as a fraction of subtotal (e.g. 0.18) when receipt.tip is 0. */
  tipRate?: number;
  /**
   * Percentage mode: each participant's share of the whole bill, parallel to
   * participants (sums to 100). When set, item claims are ignored.
   */
  percentages?: number[];
}

export interface PersonShare {
  label: string;
  items: { id: number; name: string; amount: number }[];
  itemsSubtotal: number;
  tax: number;
  tip: number;
  total: number;
  /** Set in percentage mode. */
  percent?: number;
}

export interface SplitResult {
  shares: PersonShare[];
  /** Items nobody claimed; their cost was split evenly across everyone. */
  unclaimed: ReceiptItem[];
  payerLabel: string;
  grandTotal: number;
  /** Who owes the payer what. */
  settlements: { from: string; to: string; amount: number }[];
}

/** calc */
export type CalculateSplit = (req: SplitRequest) => SplitResult;
export type FormatSummary = (result: SplitResult, receipt: Receipt) => string;

// ---------- Conversation (session <-> photon wiring) ----------

/** Session reacts to group text and returns messages to post (empty = stay quiet). */
export interface SessionApi {
  hasSession(chatId: string): boolean;
  /** Start a new split for a parsed receipt. Returns messages to send. */
  start(chatId: string, receipt: Receipt, starterLabel?: string): string[];
  /** Feed a text message. Returns messages to send (empty if not relevant). */
  handleText(chatId: string, senderId: string, text: string): string[];
  cancel(chatId: string): void;
}

// ---------- Messaging (photon layer) ----------

export interface IncomingMessage {
  chatId: string;
  senderId: string;
  senderName?: string;
  isGroup: boolean;
  text?: string;
  images: ImageInput[];
}

export interface BotHandlers {
  onMessage(msg: IncomingMessage, reply: (text: string) => Promise<void>): Promise<void>;
}
