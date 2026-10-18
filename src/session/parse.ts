/**
 * Pure parsing helpers for the split conversation. No state, no I/O.
 */

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};

/** Words that can surround item numbers without making the message "not an answer". */
const FILLER_WORDS = new Set([
  "and", "i", "had", "have", "took", "take", "got", "get", "ate", "item", "items",
  "number", "numbers", "no", "nos", "the", "mine", "me", "my", "plus", "also",
  "just", "only", "please", "pls", "thanks", "thx", "ty", "for", "was", "were", "is",
  "of", "them", "both", "with", "&",
]);

const NONE_WORDS = new Set(["none", "nothing", "nada", "skip", "n/a", "na", "zilch"]);

/** Words that look like names after "I'm ..." but are not. */
const NAME_STOPWORDS = new Set([
  ...FILLER_WORDS, ...NONE_WORDS,
  "in", "out", "good", "ok", "okay", "fine", "here", "down", "not", "so", "a", "an",
  "gonna", "going", "having", "getting", "done", "paying", "sure", "sorry", "back",
  "person", "it", "that", "this", "who", "what", "yes", "yeah", "yep", "nope",
  "cancel", "stop", "status", "help", "undo", "split", "assign", "all", "everything",
]);

export type Command = "cancel" | "status" | "help" | "back" | "done" | "split";

/** Normalize smart quotes, dashes and whitespace; lowercase is NOT applied. */
export function normalize(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Recognize a whole-message command (e.g. "cancel", "Undo!", "ok"). */
export function parseCommand(text: string): Command | null {
  const t = normalize(text).toLowerCase().replace(/[.!?]+$/g, "").trim();
  switch (t) {
    case "cancel": case "stop": case "cancel split": case "stop split": case "quit":
      return "cancel";
    case "status": case "progress": case "where are we":
      return "status";
    case "help": case "?": case "commands":
      return "help";
    case "back": case "undo": case "go back": case "redo":
      return "back";
    case "done": case "ok": case "okay": case "k": case "finish": case "confirm":
    case "looks good": case "all done": case "yes": case "yep":
      return "done";
    case "split": case "split it": case "split evenly": case "split them":
    case "split the rest": case "split rest":
      return "split";
    default:
      return null;
  }
}

/**
 * Parse a head-count answer like "3", "three", "3 people", "we're 4".
 * Returns the first number found, or null if there is none (or the message is
 * too long to plausibly be an answer). Range checking is left to the caller.
 */
export function parseCount(text: string): number | null {
  const t = normalize(text).toLowerCase();
  const words = t.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 6) return null;
  const re = /\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/;
  const m = re.exec(t);
  if (!m) return null;
  const tok = m[1];
  return /^\d+$/.test(tok) ? parseInt(tok, 10) : NUMBER_WORDS[tok];
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function isNameWord(w: string): boolean {
  return /^[A-Za-z][A-Za-z'.-]*$/.test(w) && !NAME_STOPWORDS.has(w.toLowerCase());
}

/**
 * Pull an optional self-introduced name off the front of a reply.
 *   "Alex: 1,3"        -> { name: "Alex", rest: "1,3" }
 *   "Alex Kim: none"   -> { name: "Alex Kim", rest: "none" }
 *   "I'm Alex 1 3"     -> { name: "Alex", rest: "1 3" }
 *   "1, 3"             -> { rest: "1, 3" }
 */
export function extractName(text: string): { name?: string; rest: string } {
  const t = normalize(text);

  const colon = /^([A-Za-z][A-Za-z'.-]*(?: [A-Za-z][A-Za-z'.-]*){0,2}) ?: ?(.*)$/.exec(t);
  if (colon) {
    const words = colon[1].split(" ");
    if (words.every(isNameWord)) {
      return { name: words.map(capitalize).join(" "), rest: colon[2].trim() };
    }
  }

  const intro = /^(?:i'?m|i am|this is|it'?s|its|my name is|name'?s|call me)\s+(.*)$/i.exec(t);
  if (intro) {
    const parts = intro[1].split(" ");
    const first = parts[0]?.replace(/[,.:!;-]+$/, "") ?? "";
    if (isNameWord(first)) {
      const nameWords = [first];
      let i = 1;
      // Accept a capitalized surname if it directly follows without punctuation.
      const second = parts[1]?.replace(/[,.:!;-]+$/, "");
      if (second && parts[0] === first && /^[A-Z]/.test(second) && isNameWord(second)) {
        nameWords.push(second);
        i = 2;
      }
      const rest = parts.slice(i).join(" ").replace(/^[\s,.:!;-]+/, "");
      return { name: nameWords.map(capitalize).join(" "), rest };
    }
  }

  return { rest: t };
}

export type IdListParse =
  | { kind: "ids"; ids: number[] }
  | { kind: "none" }
  | null;

/**
 * Parse an item-number list: "1, 3", "1 3 5", "2-4", "1 and 3", "#2", "none".
 * Returns null when the text is not plausibly an answer (no digits / contains
 * unrelated words). Ids are deduped and sorted but NOT validated.
 */
export function parseIdList(text: string): IdListParse {
  let t = normalize(text).toLowerCase();
  t = t.replace(/[.!?]+$/g, "").trim();
  if (!t) return null;
  if (/^(?:no items?|not? anything|i had nothing|nothing for me|none for me)$/.test(t)) return { kind: "none" };
  t = t.replace(/#\s*/g, "");
  t = t.replace(/(\d+)\s*(?:-|to|through|thru)\s*(\d+)/g, "$1-$2");
  const tokens = t.split(/[\s,;+&/]+/).filter(Boolean);

  const ids = new Set<number>();
  let sawNone = false;
  for (const raw of tokens) {
    const tok = raw.replace(/^[('"]+|[)'".!?:]+$/g, "");
    if (!tok) continue;
    if (/^\d+$/.test(tok)) {
      ids.add(parseInt(tok, 10));
    } else if (/^\d+-\d+$/.test(tok)) {
      let [a, b] = tok.split("-").map((n) => parseInt(n, 10));
      if (a > b) [a, b] = [b, a];
      if (b - a > 100) return null; // nonsense like 1-99999
      for (let i = a; i <= b; i++) ids.add(i);
    } else if (NONE_WORDS.has(tok)) {
      sawNone = true;
    } else if (FILLER_WORDS.has(tok)) {
      continue;
    } else {
      return null; // unrelated word: treat as chit-chat
    }
  }

  if (ids.size > 0) return { kind: "ids", ids: [...ids].sort((x, y) => x - y) };
  if (sawNone) return { kind: "none" };
  return null;
}

export type ClaimParse =
  | { kind: "ids"; ids: number[]; name?: string }
  | { kind: "none"; name?: string }
  | null;

/** Parse a claim reply with optional name: "Alex: 1,3", "I'm Alex 1 3", "2-4", "none". */
export function parseClaim(text: string): ClaimParse {
  // Drop an explicit "Person 2:" prefix; the bot already knows whose turn it is.
  const cleaned = normalize(text).replace(/^person\s*\d+\s*[:,-]?\s*/i, "");
  const { name, rest } = extractName(cleaned);
  const list = parseIdList(rest);
  if (!list) return null;
  return name ? { ...list, name } : list;
}

/** Validate ids against the receipt's item ids. */
export function partitionIds(ids: number[], validIds: Iterable<number>): { valid: number[]; invalid: number[] } {
  const set = new Set(validIds);
  const valid: number[] = [];
  const invalid: number[] = [];
  for (const id of ids) (set.has(id) ? valid : invalid).push(id);
  return { valid, invalid };
}

/** "assign 4, 5 to 2" / "give 4 to Alex" / "4 to 2 and 3". */
export function parseAssign(text: string): { items: string; target: string } | null {
  const t = normalize(text).replace(/[.!?]+$/g, "");
  const m = /^(?:assign|give|put)?\s*(?:items?\s*)?(.+?)\s+to\s+(.+)$/i.exec(t);
  if (!m) return null;
  // Items side must contain a digit; avoids matching ordinary sentences.
  if (!/\d/.test(m[1])) return null;
  return { items: m[1], target: m[2].trim() };
}

/**
 * Parse a payer reply: "2", "person 2", "payer 2", "2 paid", "paid by 2",
 * "Alex", "Alex paid". Returns a person number or a name to look up.
 */
export function parsePayer(text: string): { number: number } | { name: string } | null {
  const t = normalize(text).toLowerCase().replace(/[.!?]+$/g, "").trim();
  const stripped = t
    .replace(/\b(?:payer|paid|paying|pays|pay|by|is|will|was|the|bill|person|got|it|has|had|#)\b/g, " ")
    .replace(/#/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  if (/^\d+$/.test(stripped)) return { number: parseInt(stripped, 10) };
  if (Object.hasOwn(NUMBER_WORDS, stripped) && stripped !== t) return { number: NUMBER_WORDS[stripped] };
  if (/^[a-z][a-z'.-]*(?: [a-z][a-z'.-]*){0,2}$/.test(stripped)) return { name: stripped };
  return null;
}
