// Manual test: npx tsx scripts/try-vision.ts path/to/receipt.jpg
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { analyzeReceipt } from "../src/vision/index.js";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".webp": "image/webp",
};

const path = process.argv[2];
if (!path) {
  console.error("usage: npx tsx scripts/try-vision.ts <image-path-or-url>");
  process.exit(1);
}

const image = /^https?:\/\//.test(path)
  ? ({ kind: "url", url: path } as const)
  : ({
      kind: "base64",
      data: (await readFile(path)).toString("base64"),
      mimeType: MIME[extname(path).toLowerCase()] ?? "image/jpeg",
    } as const);

const started = Date.now();
const receipt = await analyzeReceipt(image);
console.log(JSON.stringify(receipt, null, 2));
console.error(`(${Date.now() - started}ms)`);
