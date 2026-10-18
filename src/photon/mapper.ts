import type { Message, Space } from "spectrum-ts";
import type { ImageInput, IncomingMessage } from "../types.js";

/** Structural subset of the SDK's Attachment content that the mapper actually uses. */
export interface AttachmentLike {
  type: "attachment";
  id: string;
  name: string;
  mimeType: string;
  read: () => Promise<Buffer>;
}

export interface MapperDeps {
  /** Convert HEIC/HEIF bytes to JPEG. If it is absent or throws, the original bytes pass through. */
  convertHeic?: (bytes: Buffer) => Promise<Buffer>;
  /** Called when an attachment fails to download (default: console.warn). */
  onAttachmentError?: (att: AttachmentLike, err: unknown) => void;
}

const HEIC_MIME = /^image\/hei[cf](-sequence)?$/i;
const HEIC_EXT = /\.(heic|heif)$/i;

/** Infers an image MIME type from the file extension when the platform sends a generic one. */
function effectiveMimeType(att: AttachmentLike): string {
  const mime = (att.mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return mime;
  if (mime === "" || mime === "application/octet-stream") {
    const n = att.name.toLowerCase();
    if (HEIC_EXT.test(n)) return "image/heic";
    if (/\.jpe?g$/.test(n)) return "image/jpeg";
    if (n.endsWith(".png")) return "image/png";
    if (n.endsWith(".webp")) return "image/webp";
    if (n.endsWith(".gif")) return "image/gif";
  }
  return mime;
}

/** The parts of a message's content the bot cares about. */
interface Collected {
  texts: string[];
  attachments: AttachmentLike[];
}

/**
 * Collects text and attachments from Spectrum content. A text-plus-photo iMessage
 * arrives as `group` content whose items are Messages, and a threaded reply wraps its
 * content in `reply`, so both are walked recursively.
 */
function collect(content: Message["content"], out: Collected, depth = 0): void {
  if (depth > 4) return;
  switch (content.type) {
    case "text":
      if (content.text.trim()) out.texts.push(content.text.trim());
      return;
    case "markdown":
      if (content.markdown.trim()) out.texts.push(content.markdown.trim());
      return;
    case "attachment":
      out.attachments.push(content);
      return;
    case "reply":
      collect(content.content as Message["content"], out, depth + 1);
      return;
    case "group":
      for (const item of content.items) collect(item.content, out, depth + 1);
      return;
    default:
      // Reactions, typing, polls, renames, membership and other non-chat events are ignored.
      return;
  }
}

/** Returns true for messages the bot sent itself, which must be ignored to avoid reply loops. */
export function isOwnMessage(message: Pick<Message, "direction" | "sender">): boolean {
  return message.direction === "outbound" || message.sender?.kind === "agent";
}

/**
 * Determines whether a space is a group chat. The iMessage provider puts `type: "dm" | "group"`
 * on the space at runtime, which the generic `Space` type doesn't declare. Group chat
 * GUIDs contain ";+;", which is used as a fallback.
 */
export function isGroupSpace(space: Pick<Space, "id">): boolean {
  const t = (space as { type?: unknown }).type;
  if (t === "group") return true;
  if (t === "dm") return false;
  return space.id.includes(";+;");
}

/**
 * Converts a Spectrum message into the bot's IncomingMessage. Image attachments are
 * downloaded and returned as base64.
 * Returns null for the bot's own messages and for messages with no text and no images
 * (tapbacks, typing, and so on).
 */
export async function toIncomingMessage(
  space: Pick<Space, "id">,
  message: Pick<Message, "direction" | "sender" | "content">,
  deps: MapperDeps = {},
): Promise<IncomingMessage | null> {
  if (isOwnMessage(message)) return null;

  const collected: Collected = { texts: [], attachments: [] };
  collect(message.content, collected);

  const images: ImageInput[] = [];
  for (const att of collected.attachments) {
    let mimeType = effectiveMimeType(att);
    if (!mimeType.startsWith("image/")) continue; // only image/* counts as an image
    try {
      let bytes = await att.read();
      if (HEIC_MIME.test(mimeType) && deps.convertHeic) {
        try {
          bytes = await deps.convertHeic(bytes);
          mimeType = "image/jpeg";
        } catch (err) {
          console.warn(`[photon] HEIC→JPEG conversion failed for ${att.name}; passing HEIC through`, err);
        }
      }
      images.push({ kind: "base64", data: bytes.toString("base64"), mimeType });
    } catch (err) {
      (deps.onAttachmentError ?? defaultAttachmentError)(att, err);
    }
  }

  const text = collected.texts.join("\n") || undefined;
  if (!text && images.length === 0) return null;

  return {
    chatId: space.id,
    senderId: message.sender?.id ?? "unknown",
    // iMessage gives only an address (phone/email), not a display name.
    senderName: undefined,
    isGroup: isGroupSpace(space),
    text,
    images,
  };
}

function defaultAttachmentError(att: AttachmentLike, err: unknown): void {
  console.warn(`[photon] failed to download attachment ${att.id} (${att.name})`, err);
}
