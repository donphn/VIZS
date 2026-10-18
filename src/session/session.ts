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
  parseMode,
  parsePayer,
  parsePercents,
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

type Phase = "AWAITING_COUNT" | "CHOOSE_MODE" | "CLAIMING" | "PERCENT" | "CONFIRM";

interface Person {
  name?: string;
  itemIds: Set<number>;
}

interface Session {
  receipt: Receipt;
  phase: Phase;
  /** "items": each person claims items. "percent": each person pays a share of the whole bill. */
  mode: "items" | "percent";
  /** Percent mode only: parallel to people, sums to 100. */
  percents: number[];
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
      mode: "items",
      percents: [],
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
      case "CHOOSE_MODE":
        out = this.onChooseMode(s, text, cmd);
        break;
      case "CLAIMING":
        out = this.onClaim(s, text, cmd);
        break;
      case "PERCENT":
        out = this.onPercent(s, text, cmd);
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
    s.payerIndex = 0;
    s.splitAcked = false;
    s.percents = [];
    if (n === 1) {
      s.mode = "items";
      s.phase = "CLAIMING";
      return [`Got it, just 1 person.\n${this.claimPrompt(s, true)}`];
    }
    s.phase = "CHOOSE_MODE";
    return [`Got it, ${n} people.\n${modeQuestion()}`];
  }

  private onChooseMode(s: Session, text: string, cmd: ReturnType<typeof parseCommand>): string[] {
    if (cmd === "back") return [this.undo(s)];
    const mode = cmd === "split" ? "even" : parseMode(text);
    if (mode === "items") {
      s.mode = "items";
      s.phase = "CLAIMING";
      s.index = 0;
      return [`Item by item it is!\n${this.claimPrompt(s, true)}\n${this.itemsWithMarks(s)}`];
    }
    if (mode === "percent" || mode === "even") {
      s.mode = "percent";
      s.phase = "PERCENT";
      if (mode === "even") return this.applyPercents(s, evenPercents(s.people.length), []);
      return [this.percentPrompt(s)];
    }
    // Shortcut: they typed the percentages straight away ("50 30 20").
    const pct = parsePercents(text);
    if (pct && pct.percents.length === s.people.length) {
      s.mode = "percent";
      s.phase = "PERCENT";
      return this.onPercent(s, text, null);
    }
    if (/\d/.test(text) && text.length <= 40) return [`Sorry, didn't catch that. ${modeQuestion()}`];
    return [];
  }

  private onPercent(s: Session, text: string, cmd: ReturnType<typeof parseCommand>): string[] {
    if (cmd === "back") return [this.undo(s)];
    if (cmd === "split" || parseMode(text) === "even") {
      return this.applyPercents(s, evenPercents(s.people.length), []);
    }
    const parsed = parsePercents(text);
    if (!parsed) return []; // chit-chat
    const n = s.people.length;
    if (parsed.percents.length !== n) {
      return [`I need ${n} percentages, one per person (you sent ${parsed.percents.length}). e.g. ${percentExample(n)}`];
    }
    const total = parsed.percents.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 100) > 0.1) {
      return [`Those add up to ${Math.round(total * 10) / 10}%, but they need to total 100%. Try again, e.g. ${percentExample(n)}`];
    }
    return this.applyPercents(s, parsed.percents, parsed.names);
  }

  private applyPercents(s: Session, percents: number[], names: (string | undefined)[]): string[] {
    s.percents = percents;
    names.forEach((name, i) => {
      if (name) s.people[i].name = name;
    });
    s.phase = "CONFIRM";
    const fmt = (n: number) => money(n, s.receipt.currency);
    const lines = s.people.map(
      (_, i) => `${this.label(s, i)}: ${fmtPct(percents[i])} ≈ ${fmt((s.receipt.total * percents[i]) / 100)}`,
    );
    return [`✓ Splitting by percentage:\n${lines.join("\n")}\n\n${this.payerQuestion(s)}`];
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
    if (s.phase === "CHOOSE_MODE") {
      s.phase = "AWAITING_COUNT";
      s.people = [];
      s.countNudged = false;
      return "Ok, starting over. How many people are splitting this?";
    }
    if (s.phase === "PERCENT" || (s.phase === "CLAIMING" && s.index === 0 && s.people.length > 1)) {
      s.phase = "CHOOSE_MODE";
      s.people.forEach((p) => p.itemIds.clear());
      s.percents = [];
      return `Ok. ${modeQuestion()}`;
    }
    if (s.phase === "CONFIRM" && s.mode === "percent") {
      s.phase = "PERCENT";
      s.percents = [];
      return `Ok, let's redo the percentages.\n${this.percentPrompt(s)}`;
    }
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
      const result = this.calculateSplit({
        receipt: s.receipt,
        participants: s.mode === "percent" ? participants.map((p) => ({ ...p, itemIds: [] })) : participants,
        payerIndex: s.payerIndex,
        ...(s.mode === "percent" ? { percentages: s.percents } : {}),
      });
      const summary = this.formatSummary(result, s.receipt);
      this.sessions.delete(chatId);
      return [summary];
    } catch {
      return [`Sorry, something went wrong calculating the split 😕 Reply "done" to try again or "cancel".`];
    }
  }

  // ---------- text builders ----------

  private percentPrompt(s: Session): string {
    const n = s.people.length;
    return (
      `What percentage does each person pay? Send ${n} numbers that add up to 100, ` +
      `e.g. ${percentExample(n)}, or "even". Names are optional: "Alex 60, Sam 40".`
    );
  }

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
      case "CHOOSE_MODE":
        return `Splitting ${total} between ${s.people.length}.\n${modeQuestion()}`;
      case "PERCENT":
        return `Splitting ${total} between ${s.people.length} by percentage.\n${this.percentPrompt(s)}`;
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
        const done = s.people.map((p, i) =>
          s.mode === "percent"
            ? `${this.label(s, i)}: ${fmtPct(s.percents[i])}`
            : `${this.label(s, i)}: ${p.itemIds.size ? [...p.itemIds].join(", ") : "nothing"}`,
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
    if (s.mode === "percent") return [];
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
  if (s.phase === "CHOOSE_MODE" || s.phase === "PERCENT" || s.mode === "percent") {
    lines.push(
      "• \"items\" to claim what each person had, or \"percent\" to split by percentage",
      "• Percentages: \"50 30 20\", \"Alex 60, Sam 40\" or \"even\"",
      "• \"undo\" goes back a step, \"status\" shows progress, \"cancel\" stops the split",
    );
    if (s.phase === "CONFIRM") lines.push("• A person number for who's paying, \"done\" to finish");
    return lines.join("\n");
  }
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

function modeQuestion(): string {
  return (
    "How do you want to split it?\n" +
    "1. Items: everyone claims what they ordered\n" +
    "2. Percent: everyone pays a share of the bill (or \"even\")\n" +
    "Reply \"items\" or \"percent\"."
  );
}

function evenPercents(n: number): number[] {
  return Array.from({ length: n }, () => 100 / n);
}

function fmtPct(p: number): string {
  return `${Math.round(p * 10) / 10}%`;
}

function percentExample(n: number): string {
  const examples: Record<number, string> = { 2: '"60 40"', 3: '"50 30 20"', 4: '"40 30 20 10"' };
  return examples[n] ?? `"${evenPercents(n).map((p) => Math.round(p)).join(" ")}"`;
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
