# Obsidian Diary Bot

> An Obsidian plugin that turns journaling into a conversation. Chat with an AI companion from your phone; the plugin files each chat into your vault as a daily note, builds a profile of you per life area, and gives you a dashboard, timeline, photo wall and people graph.

**中文简介：** 这是一个 Obsidian 插件 + 云端后端。在手机上和 AI 聊天，聊完自动整理成 Obsidian 日记，并按 8 个生活领域持续积累你的画像；插件自带仪表盘、时间线、照片墙和人物关系图。云端全部跑在 Cloudflare 免费额度内，零运营成本。

Backend: a Cloudflare Worker (free tier, always-on). Frontend: an Obsidian plugin (writes to your vault, never touches your data after that).

## Why I built it

Most people stop journaling because a blank page is hard to face. Talking is easier than writing, so the entry point is a chat that asks a good question, reflects briefly and then gets out of the way. The conversation is saved into Obsidian as plain Markdown, so the notes stay yours and portable.

The product is the **Obsidian plugin** (vault writer, profiles, views, memory) plus the Worker behind it. Telegram is only the current input channel, chosen because its Bot API is free, has no review process and supports photos and buttons. The Worker owns the conversation, and the plugin only pulls finished entries, so the capture channel is a thin layer on top.

**Known limitation:** Telegram is not commonly used in mainland China and may need a network workaround there; `workers.dev` addresses can also be unreliable from some networks. Supporting a channel that is native to mainland users (for example a WeChat-based one) is the main open item.

---

## What it does

- **Capture from anywhere** — Telegram is the current input channel. Send text or photos from your phone, watch, browser, etc.
- **Topic-driven chat** — pick from 8 life areas (work / friends / family / love / self / goals / health / random) at the start of each session. Each topic accumulates a profile of *who you are in that area*.
- **AI reflection** — quiet, varied responses (60% reflect+question, 25% pure empathy, 15% pattern observation). No clinical distance.
- **Cloud-side AI** — the Worker handles AI even when Obsidian is closed. Your phone is always-on; your laptop doesn't need to be.
- **Auto-summarized vault notes** — `/save` triggers cloud-side summarization. AI extracts mood, energy, entities. Plugin pulls and writes a Day One-shape Markdown entry to today's daily note.
- **Memory tiers** — last N days full-text + older entries via tag overlap + entity backlinks. No vector embeddings, no extra paid services.
- **Photo gallery, timeline, people graph, dashboard, calendar heatmap** — all native Obsidian views, no peer-plugin required (map view optional via [esm7/obsidian-map-view](https://github.com/esm7/obsidian-map-view)).
- **Day One compatible frontmatter** — `mood`, `energy`, `starred`, `pinned`, `location`. Easy to migrate in/out.

---

## Architecture

```
Telegram  ──webhook──►  Cloudflare Worker  ──D1 + KV──►  Obsidian plugin (pulls)
   ▲                          │                                │
   │                          ├─ AI reflection (DeepSeek API)  │
   │                          ├─ Topic profile (D1 evolving)   ▼
   └────── reply ─────────────┴─ Finalize packet              your vault
```

- **Worker** — always-on, AI is canonical, owns conversation context. Free tier (100k req/day) is more than enough.
- **Plugin** — a thin vault writer. Pulls finalize packets every 3s, writes Markdown, downloads photos. No AI in the hot path.
- **D1** — entities + mentions + cooccurrences + topic profiles.
- **KV** — short-term state (queue, ctx, prefs).

---

## Setup

### 1. Cloudflare Worker (~5 min)

```bash
cd worker
npm install
npx wrangler login

# create resources
npx wrangler kv:namespace create MESSAGES   # paste id into wrangler.toml
npx wrangler kv:namespace create BINDINGS   # paste id into wrangler.toml
npx wrangler d1 create diary-bot-db          # paste database_id into wrangler.toml
npx wrangler d1 execute diary-bot-db --file=src/schema.sql --remote

# secrets — at minimum BOT_TOKEN + DEEPSEEK_API_KEY
npx wrangler secret put BOT_TOKEN          # from @BotFather
npx wrangler secret put DEEPSEEK_API_KEY   # from platform.deepseek.com

# deploy
npx wrangler deploy
# note the URL it prints — e.g. https://diary-bot-relay.<your-subdomain>.workers.dev
```

Then register the webhook (one-time):

```
GET https://<your-worker>.workers.dev/setup-webhook
```

### 2. Obsidian plugin

Copy this repo (or only `manifest.json`, `main.js`, `styles.css`) to:

```
<vault>/.obsidian/plugins/obsidian-diary-bot/
```

Or build from source: `npm install && npm run build`.

Enable it in Settings → Community plugins. Open plugin settings:

1. Paste your Worker URL into **Relay URL**.
2. Click **Connect Telegram** — opens a one-tap deep link to your bot.
3. In the Telegram chat that opens, just tap the link. Plugin auto-connects.

That's it.

---

## Daily flow

1. Open Telegram → your bot.
2. Send any message → bot asks you to pick a topic (8 buttons).
3. Pick one → bot offers a journaling prompt + 🎲 reroll / 💭 skip buttons.
4. Chat naturally. Bot reflects briefly, sometimes silent, sometimes asks.
5. When done, send `/save`. Bot summarizes, saves to vault.
6. Open Obsidian when convenient — your entry is in today's daily note.

---

## Commands

| Command | Effect |
|---------|--------|
| `/chat` | Switch to AI chat mode + pick topic |
| `/silent` | Record only, no AI replies |
| `/save` | Save current entry to vault (legacy `/done` also works) |
| `/cancel` | Discard current entry |
| `/search <name>` | Find a person / place / project mentioned in your diary |
| `/ask <question>` | Ask anything about your diary (uses last 30 days) |
| `/onthisday` | Past entries on this calendar day |
| `/stats` | Writing stats + streak |
| `/help` | Full menu |

---

## Plugin views

Open from the left ribbon icons or `Ctrl+P`:

- **Diary Dashboard** (📊) — 30-day heatmap, mood/energy trend, this-month calendar, streak, top entities.
- **Photo Wall** (🖼) — masonry of all attachments grouped by month. Click → opens parent entry.
- **Timeline** (📋) — chronological card stream with thumbnails + mood badges.
- **People Graph** (👥) — entities + cooccurrences sorted by mention count.
- **Map View** (📍) — opens `obsidian-map-view` (peer plugin). Entries with `location: "lat,lng"` frontmatter appear as pins.

Plus commands:
- `Open Topics from Cloud` — sync evolved topic profiles into `Journal/Topics/<topic>.md` (you can edit; changes reverse-push to Worker D1).
- `Backfill Topic Mentions from Vault → Cloud` — one-shot import of existing diary into D1.
- `Cleanup Entity Notes (dedup + blocklist)` — merge variants, drop generic noise.
- `Export Diary as Book (PDF / Markdown)` — yearbook export.

---

## Notes on privacy

- All data stored in: your CF Worker (KV + D1) + your Obsidian vault. No third party.
- DeepSeek API receives prompts you send for reflection. If you want zero-cloud-AI, switch the AI provider to a local Ollama in plugin settings (offline reflection only).
- Bot token + DeepSeek key live as Cloudflare secrets — never exposed to plugin or vault.

---

## License

MIT — see [LICENSE](LICENSE).

Acknowledgements:
- AI Providers abstraction pattern: [pfrankov/obsidian-local-gpt](https://github.com/pfrankov/obsidian-local-gpt) (MIT)
- Topic profile schema inspiration: [memodb-io/memobase](https://github.com/memodb-io/memobase) (Apache-2.0)
- Async deriver pattern (read for ideas): [plastic-labs/honcho](https://github.com/plastic-labs/honcho) (AGPL)
- PDF export pipeline: [l1xnan/obsidian-better-export-pdf](https://github.com/l1xnan/obsidian-better-export-pdf) (MIT)
- Heatmap render: [Richardsl/heatmap-calendar-obsidian](https://github.com/Richardsl/heatmap-calendar-obsidian) (MIT)
- Photo gallery: [Lam-L/ObJournal](https://github.com/Lam-L/ObJournal) (MIT) — adaptive count layout idea
- Telegram-first capture: [soberhacker/obsidian-telegram-sync](https://github.com/soberhacker/obsidian-telegram-sync) (AGPL — no code copy)
