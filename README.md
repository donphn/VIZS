# VIZS: Receipt Splitter Bot

An iMessage group bot built on [Photon Spectrum](https://photon.codes/docs/spectrum-ts/getting-started). It uses Grok to read receipt photos. Drop a restaurant receipt photo in the group and the bot reads it, asks how many people are splitting, has each person claim their items, and then posts who owes what. Tax and tip are split in proportion to what each person ordered.

## Setup

1. **Photon:** sign up at https://app.photon.codes, create a project, and make sure it has an iMessage line. Copy the project's **Project ID** and **Secret Key** from Settings.
2. **Grok:** create an API key at https://console.x.ai.
3. Configure and install:
   ```bash
   cp .env.example .env    # fill in PHOTON_PROJECT_ID, PHOTON_SECRET_KEY, GROK_API_KEY
   npm install
   npm start
   ```
   The bot connects to Photon over a long-lived stream, so you don't need a webhook or a public URL. Press Ctrl+C to stop.

Optional `.env` settings: `GROK_VISION_MODEL` (default `grok-4.7`) and `GROK_BASE_URL`.

## Testing in a group chat

1. Create an iMessage group with a couple of friends and **your Photon line's number**. A DM with the line also works if you want to try it solo.
2. Send a photo of a receipt. HEIC photos straight from an iPhone are fine; they're converted to JPEG.
3. Follow the prompts:
   ```
   Bot:  🧾 Joe's Diner — $41.28
         1. Burger $14.00
         2. Salad $12.00
         3. Fries $6.00
   Bot:  How many people are splitting this?
   You:  2
   Bot:  How do you want to split it? 1. Items  2. Percent
   You:  items               ← or "percent" (see below)
   Bot:  Person 1, which items did you have? …
   You:  Alex: 1, 3          ← "1 3", "2-4", "none" also work; names are optional
   Bot:  Got it, Alex: Burger, Fries. Person 2…
   You:  Sam: 2, 3           ← items claimed by several people are split between them
   Bot:  …Who's paying the bill? Reply "done" to finish.
   You:  done
   Bot:  🧾 Split for Joe's Diner — total $41.28 … Venmo Alex: • Sam → $…
   ```

**Splitting by percentage:** reply `percent` to the "how do you want to split it?" question, then send everyone's share in one message: `50 30 20`, `Alex 60, Sam 40`, or `even`. The shares must add up to 100%. Food, tax and tip are all split by those percentages. You can also skip the question and send the percentages right away.

**Commands during a split:** `status`, `undo` / `back`, `cancel`, `help`. At the end: `split` (share unclaimed items evenly), `assign 3,4 to 2`, a person number or name to set who's paying, then `done`.

**What the bot replies to:**
- Photos that aren't receipts get no reply.
- A receipt it can't read (blurry, dark, cut off) gets a "can't read it clearly" message asking for a better photo.
- Ordinary group chatter is ignored unless a split is in progress and the message looks like an answer.
- A split expires after 30 minutes of inactivity. Sending a new receipt replaces the current split.

**Try vision without iMessage:**
```bash
npx tsx scripts/try-vision.ts path/to/receipt.jpg
```

## Development

```bash
npm test          # vitest (unit tests for each module + end-to-end flow in src/app.test.ts)
npm run typecheck
```

| Module | Role |
|---|---|
| `src/types.ts` | Shared interfaces between modules |
| `src/photon/` | Spectrum client, message mapping, per-chat ordered queue, reconnects, HEIC → JPEG |
| `src/vision/` | Grok client and receipt classification (ok / unreadable / not a receipt) |
| `src/session/` | Conversation steps for each chat (head count → claims → confirm) |
| `src/calc/` | Split math in whole cents, with tax and tip split by what each person ordered; summary text |
| `src/app.ts` | Connects vision and session to the Photon message loop |

**Notes**
- Shares are matched to the printed receipt total when the gap is small (≤5% or $5). For a bigger gap the split is left as calculated and the summary includes a "double-check the receipt" warning.
- Sessions are kept in memory, so restarting the bot clears any split in progress.
