import type {
  CalculateSplit,
  FormatSummary,
  Participant,
  Receipt,
  ReceiptItem,
  SessionApi,
} from "../types.js";
import {
  parseAssign,
  parseClaim,
  parseCommand,
  parseCount,
  parseIdList,
  parsePayer,
  partitionIds,
} from "./parse.js";

export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const MAX_PEOPLE = 20;

export interface SessionManagerOptions {
  calculateSplit: CalculateSplit;
  formatSummary: FormatSummary;
  /** Inactivity timeout. Default 30 minutes. */
  ttlMs?: number;
  /** Clock override for tests. Default Date.now. */
  now?: () => number;
}

type Phase = "AWAITING_COUNT" | "CLAIMING" | "CONFIRM";

interface Person {
  name?: string;
  itemIds: Set<number>;
}

interface Session {
  receipt: Receipt;
  phase: Phase;
  people: Person[];
  /** Whose turn it is during CLAIMING. */
  index: number;
  payerIndex: number;
  /** User explicitly said "split" for unclaimed items. */
  splitAcked: boolean;
  /** We already nudged once for a non-number reply in AWAITING_COUNT. */
  countNudged: boolean;
  lastActive: number;
}

export class SessionManager implements SessionApi {
  private readonly sessions = new Map<string, Session>();
  private readonly calculateSplit: CalculateSplit;
  private readonly formatSummary: FormatSummary;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: SessionManagerOptions) {
    this.calculateSplit = opts.calculateSplit;
    this.formatSummary = opts.formatSummary;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  hasSession(chatId: string): boolean {
    return this.get(chatId) !== undefined;
  }

  cancel(chatId: string): void {
    this.sessions.delete(chatId);
  }

  start(chatId: string, receipt: Receipt, starterLabel?: string): string[] {
    const replaced = this.hasSession(chatId);
    this.sessions.set(chatId, {
      receipt,
      phase: "AWAITING_COUNT",
      people: [],
      index: 0,
      payerIndex: 0,
      splitAcked: false,
      countNudged: false,
      lastActive: this.now(),
    });

    const fmt = (n: number) => money(n, receipt.currency);
    const header = receipt.merchant
      ? `🧾 ${receipt.merchant}, total ${fmt(receipt.total)}`
      : `🧾 Receipt total ${fmt(receipt.total)}`;
    const extras: string[] = [];
    if (receipt.tax) extras.push(`tax ${fmt(receipt.tax)}`);
    if (receipt.tip) extras.push(`tip ${fmt(receipt.tip)}`);
    const lines = [
      ...(replaced ? ["(Previous split discarded.)"] : []),
      starterLabel ? `Thanks ${starterLabel}! ${header}` : header,
      ...receipt.items.map((it) => itemLine(it, receipt.currency)),
      ...(extras.length ? [`Plus ${extras.join(", ")}`] : []),
    ];
    return [lines.join("\n"), "How many people are splitting this?"];
  }

  handleText(chatId: string, _senderId: string, text: string): string[] {
    const s = this.get(chatId);
    if (!s) return [];

    const cmd = parseCommand(text);
    if (cmd === "cancel") {
      this.sessions.delete(chatId);
      return ["Split cancelled 👍 Send a receipt photo anytime to start a new one."];
    }
    if (cmd === "help") {
      s.lastActive = this.now();
      return [helpText(s)];
    }
    if (cmd === "status") {
      s.lastActive = this.now();
      return [this.statusText(s)];
    }

    let out: string[];
    switch (s.phase) {
      case "AWAITING_COUNT":
        out = this.onCount(s, text);
        break;
      case "CLAIMING":
        out = this.onClaim(s, text, cmd);
        break;
      case "CONFIRM":
        out = this.onConfirm(chatId, s, text, cmd);
        break;
    }
    // Only real interactions keep the session alive; ignored chit-chat doesn't.
    if (out.length > 0 && this.sessions.has(chatId)) s.lastActive = this.now();
    return out;
  }

  // ---------- phases ----------

  private onCount(s: Session, text: string): string[] {
    const n = parseCount(text);
    if (n === null) {
      if (s.countNudged) return [];
      s.countNudged = true;
      return [`How many people are splitting? Reply with a number (1-${MAX_PEOPLE}).`];
    }
    if (!Number.isInteger(n) || n < 1 || n > MAX_PEOPLE) {
      return [`I can split between 1 and ${MAX_PEOPLE} people. How many are splitting?`];
    }
    s.people = Array.from({ length: n }, () => ({ itemIds: new Set<number>() }));
    s.index = 0;
    s.phase = "CLAIMING";
    s.payerIndex = 0;
    s.splitAcked = false;
    const intro = n === 1 ? "Got it, just 1 person." : `Got it, ${n} people.`;
    return [`${intro}\n${this.claimPrompt(s, true)}`];
  }

  private onClaim(s: Session, text: string, cmd: ReturnType<typeof parseCommand>): string[] {
    if (cmd === "back") return [this.undo(s)];

    const claim = parseClaim(text);
    if (!claim) return []; // chit-chat: stay quiet

    const person = s.people[s.index];
    const validIds = s.receipt.items.map((i) => i.id);
    if (claim.kind === "ids") {
      const { valid, invalid } = partitionIds(claim.ids, validIds);
      if (invalid.length > 0) {
        const range = idRange(validIds);
        return [
          `Hmm, there's no item ${joinList(invalid.map(String), "or")}${range ? ` (items are ${range})` : ""}. ` +
            `${this.label(s, s.index, claim.name)}, which items did you have?`,
        ];
      }
      person.itemIds = new Set(valid);
    } else {
      person.itemIds = new Set();
    }
    if (claim.name) person.name = claim.name;

    const who = this.label(s, s.index);
    const took =
      person.itemIds.size === 0
        ? `${who}: nothing, got it.`
        : `✓ ${who}: ${[...person.itemIds].map((id) => this.itemShort(s, id)).join(", ")}`;

    s.index++;
    if (s.index < s.people.length) {
      return [`${took}\n\n${this.claimPrompt(s, false)}\n${this.itemsWithMarks(s)}`];
    }
    s.phase = "CONFIRM";
    return [`${took}\n\n${this.confirmPrompt(s)}`];
  }

  private onConfirm(
    chatId: string,
    s: Session,
    text: string,
    cmd: ReturnType<typeof parseCommand>,
  ): string[] {
    if (cmd === "done") return this.finish(chatId, s);
    if (cmd === "back") return [this.undo(s)];
    if (cmd === "split") {
      s.splitAcked = true;
      const unclaimed = this.unclaimed(s);
      const what = unclaimed.length
        ? `Ok, ${joinList(unclaimed.map((i) => `#${i.id}`), "and")} will be split evenly.`
        : "Nothing's unclaimed, all good.";
      return [`${what}\n${this.payerQuestion(s)}`];
    }

    const assign = parseAssign(text);
    if (assign) return [this.onAssign(s, assign.items, assign.target)];

    const payer = parsePayer(text);
    if (payer) {
      const idx = this.resolvePerson(s, payer);
      if (idx === null) {
        // A bare unknown word is probably chit-chat; only complain about numbers.
        return "number" in payer ? [`There's no person ${payer.number} (pick 1-${s.people.length}).`] : [];
      }
      s.payerIndex = idx;
      if (this.unclaimed(s).length === 0 || s.splitAcked) return this.finish(chatId, s);
      return [`${this.label(s, idx)} is paying the bill. 👍\n${this.confirmPrompt(s, true)}`];
    }
    // Looks like an attempt with numbers but we couldn't read it.
    if (/\d/.test(text) && text.length <= 40) {
      return [`Sorry, didn't catch that. ${this.confirmHint(s)}`];
    }
    return [];
  }

  private onAssign(s: Session, itemsText: string, targetText: string): string {
    const list = parseIdList(itemsText);
    if (!list || list.kind !== "ids") return `Sorry, which items? e.g. "assign 4 to 2".`;
    const { valid, invalid } = partitionIds(list.ids, s.receipt.items.map((i) => i.id));
    if (invalid.length) return `There's no item ${joinList(invalid.map(String), "or")}. ${this.confirmHint(s)}`;

    const targets: number[] = [];
    const targetNums = parseIdList(targetText.replace(/\bperson\b/gi, ""));
    if (targetNums && targetNums.kind === "ids") {
      const bad = targetNums.ids.filter((n) => n < 1 || n > s.people.length);
      if (bad.length) return `There's no person ${joinList(bad.map(String), "or")} (pick 1-${s.people.length}).`;
      targets.push(...targetNums.ids.map((n) => n - 1));
    } else {
      const idx = this.resolvePerson(s, { name: targetText.toLowerCase() });
      if (idx === null) return `I don't know who "${targetText}" is. Use a person number, e.g. "assign 4 to 2".`;
      targets.push(idx);
    }

    for (const t of targets) for (const id of valid) s.people[t].itemIds.add(id);
    const who = joinList(targets.map((t) => this.label(s, t)), "and");
    const items = valid.map((id) => this.itemShort(s, id)).join(", ");
    return `✓ ${items} → ${who}\n${this.confirmPrompt(s, true)}`;
  }

  private undo(s: Session): string {
    s.splitAcked = false;
    if (s.phase === "CONFIRM") {
      s.phase = "CLAIMING";
      s.index = s.people.length - 1;
    } else if (s.index > 0) {
      s.index--;
    } else {
      s.phase = "AWAITING_COUNT";
      s.people = [];
      s.countNudged = false;
      return "Ok, starting over. How many people are splitting this?";
    }
    s.people[s.index].itemIds = new Set();
    return `Ok, let's redo ${this.label(s, s.index)}.\n${this.claimPrompt(s, false)}\n${this.itemsWithMarks(s)}`;
  }

  private finish(chatId: string, s: Session): string[] {
    const participants: Participant[] = s.people.map((p, i) => ({
      label: this.label(s, i),
      itemIds: [...p.itemIds].sort((a, b) => a - b),
    }));
    try {
      const result = this.calculateSplit({ receipt: s.receipt, participants, payerIndex: s.payerIndex });
      const summary = this.formatSummary(result, s.receipt);
      this.sessions.delete(chatId);
      return [summary];
    } catch {
      return [`Sorry, something went wrong calculating the split 😕 Reply "done" to try again or "cancel".`];
    }
  }

  // ---------- text builders ----------

  private claimPrompt(s: Session, first: boolean): string {
    const q = `${this.label(s, s.index)}, which items did you have?`;
    if (!first) return q;
    return (
      `${q} Reply with item numbers like "1, 3" or "2-4", or "none". ` +
      `Add your name if you like: "Alex: 1, 3".`
    );
  }

  private confirmPrompt(s: Session, afterChange = false): string {
    const unclaimed = this.unclaimed(s);
    const lines: string[] = [];
    if (unclaimed.length && !s.splitAcked) {
      if (!afterChange) lines.push("Almost done!");
      lines.push(`Nobody claimed:\n${unclaimed.map((it) => itemLine(it, s.receipt.currency)).join("\n")}`);
      const eg = unclaimed[0].id;
      lines.push(`Reply "assign ${eg} to <person #>" or "split" to share them evenly.`);
    } else if (!afterChange) {
      lines.push("Everyone's in! 🎉");
    }
    lines.push(this.payerQuestion(s));
    return lines.join("\n");
  }

  private payerQuestion(s: Session): string {
    const people = s.people.map((_, i) => `${i + 1}. ${this.label(s, i)}`).join("\n");
    return (
      `Who's paying the bill? Reply with a person number (default 1).\n${people}\n` +
      `Reply "done" to finish.`
    );
  }

  private confirmHint(s: Session): string {
    const parts = [`a person number for who's paying`];
    if (this.unclaimed(s).length && !s.splitAcked) parts.unshift(`"assign <item> to <person #>", "split"`);
    return `Reply ${parts.join(", ")}, or "done".`;
  }

  private statusText(s: Session): string {
    const total = money(s.receipt.total, s.receipt.currency);
    switch (s.phase) {
      case "AWAITING_COUNT":
        return `Splitting ${total}. Waiting to hear how many people are splitting.`;
      case "CLAIMING": {
        const done = s.people
          .slice(0, s.index)
          .map((p, i) => `${this.label(s, i)}: ${p.itemIds.size ? [...p.itemIds].join(", ") : "nothing"}`);
        return [
          `Splitting ${total} between ${s.people.length}.`,
          ...done,
          `Waiting on ${this.label(s, s.index)} (${s.index + 1} of ${s.people.length}).`,
          this.itemsWithMarks(s),
        ].join("\n");
      }
      case "CONFIRM": {
        const done = s.people.map(
          (p, i) => `${this.label(s, i)}: ${p.itemIds.size ? [...p.itemIds].join(", ") : "nothing"}`,
        );
        return [`Splitting ${total} between ${s.people.length}.`, ...done, "", this.confirmPrompt(s, true)].join("\n");
      }
    }
  }

  /** All items, with claimed ones marked and their claimers named. */
  private itemsWithMarks(s: Session): string {
    return s.receipt.items
      .map((it) => {
        const by = s.people
          .map((p, i) => (p.itemIds.has(it.id) ? this.label(s, i) : null))
          .filter((x): x is string => x !== null);
        const base = itemLine(it, s.receipt.currency);
        return by.length ? `${base} ✓ ${by.join(", ")}` : base;
      })
      .join("\n");
  }

  private itemShort(s: Session, id: number): string {
    const it = s.receipt.items.find((i) => i.id === id);
    return it ? `${id}. ${it.name}` : `#${id}`;
  }

  // ---------- helpers ----------

  private label(s: Session, i: number, pendingName?: string): string {
    return pendingName ?? s.people[i]?.name ?? `Person ${i + 1}`;
  }

  private unclaimed(s: Session): ReceiptItem[] {
    return s.receipt.items.filter((it) => !s.people.some((p) => p.itemIds.has(it.id)));
  }

  private resolvePerson(s: Session, ref: { number: number } | { name: string }): number | null {
    if ("number" in ref) {
      return ref.number >= 1 && ref.number <= s.people.length ? ref.number - 1 : null;
    }
    const name = ref.name.trim().toLowerCase();
    const idx = s.people.findIndex((p, i) => {
      const label = this.label(s, i).toLowerCase();
      return label === name || (p.name ? p.name.toLowerCase().split(" ")[0] === name : false);
    });
    return idx >= 0 ? idx : null;
  }

  private get(chatId: string): Session | undefined {
    const s = this.sessions.get(chatId);
    if (!s) return undefined;
    if (this.now() - s.lastActive > this.ttlMs) {
      this.sessions.delete(chatId);
      return undefined;
    }
    return s;
  }
}

// ---------- module-level formatting ----------

function helpText(s: Session): string {
  const lines = ["Here's how this works:"];
  if (s.phase === "AWAITING_COUNT") lines.push("• Reply with how many people are splitting, e.g. \"3\"");
  lines.push(
    "• When it's your turn, reply with item numbers: \"1, 3\", \"2-4\" or \"none\"",
    "• Add a name: \"Alex: 1, 3\" or \"I'm Alex 1 3\"",
    "• Items claimed by several people get shared",
    "• \"undo\" redoes the previous person",
    "• \"status\" shows progress, \"cancel\" stops the split",
  );
  if (s.phase === "CONFIRM") {
    lines.push("• \"assign 4 to 2\" or \"split\" for unclaimed items, a person number for who's paying, \"done\" to finish");
  }
  return lines.join("\n");
}

function itemLine(it: ReceiptItem, currency: string): string {
  const qty = it.quantity > 1 ? `${it.quantity}x ` : "";
  return `${it.id}. ${qty}${it.name} ${money(it.price, currency)}`;
}

export function money(n: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function joinList(xs: string[], conj: "and" | "or"): string {
  if (xs.length <= 1) return xs.join("");
  if (xs.length === 2) return `${xs[0]} ${conj} ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")} ${conj} ${xs[xs.length - 1]}`;
}

function idRange(ids: number[]): string {
  if (ids.length === 0) return "";
  const sorted = [...ids].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  return contiguous ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(", ");
}
