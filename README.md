# LinkedIn Saved Posts Extractor

A Chrome extension that automatically extracts your LinkedIn saved posts on a schedule and saves them as CSV files — no passwords stored, runs in your existing LinkedIn session.

Built by [Bilal Anwersh](https://www.linkedin.com/in/bilalanwersh/) · Open-sourced as a proof-of-concept for [Trove](https://usetrove.app), where this workflow runs natively without any setup.

---

## What it does

- Silently extracts your LinkedIn saved posts in the background on a schedule you choose (every 12h or 24h)
- Picks up from where the last run left off — never re-downloads posts you've already extracted
- Saves a **session CSV** (this run only) and a **master CSV** (all runs combined) to your Downloads folder
- **Optional**: uses your Anthropic or OpenAI API key to generate a concise AI title for each post before writing the CSV

---

## Installation

1. **Clone or download this repository**
   ```
   git clone https://github.com/bilalanwersheikh/trove-social-scrapper.git
   ```
   Or click **Code → Download ZIP** on GitHub and unzip it anywhere on your machine.

2. **Open Chrome's extension manager**
   Navigate to `chrome://extensions` in your address bar.

3. **Enable Developer Mode**
   Toggle the **Developer mode** switch in the top-right corner.

4. **Load the extension**
   Click **Load unpacked** and select the `chrome-extension-prod/` folder inside the cloned/unzipped repo (that folder contains `manifest.json` at its root).

5. **Complete setup**
   The setup page opens automatically on first install. Choose your schedule, batch size, output folder, and optionally add an AI API key.

---

## Setup walkthrough

| Step | What to do |
|------|------------|
| 1 | Make sure you're signed in to LinkedIn in Chrome |
| 2 | Choose extraction schedule: every 12h or every 24h |
| 3 | Choose batch size: 10 / 25 / 50 / 100 posts per run |
| 4 | Optionally name a sub-folder inside Downloads (e.g. `linkedin-csv`) |
| 5 | Optionally paste an Anthropic or OpenAI API key to enable AI-generated titles |

You can change any of these later via the extension popup.

---

## Output files

Both files are saved to `Downloads/` (or `Downloads/<your-subfolder>/`):

| File | Contents |
|------|----------|
| `YYMMDD_linkedin_saved_posts.csv` | Posts extracted in this run only |
| `master_linkedin_saved_posts.csv` | All posts ever extracted (cumulative) |

**Columns:**

| Column | Description |
|--------|-------------|
| `Author's Name` | Display name on the post card |
| `Title` | AI-generated title (if enabled), otherwise blank |
| `Post Content` | Full post text (expanded via "see more") |
| `Post Date` | Approximate date derived from LinkedIn's relative timestamp |
| `Post URL` | Direct link to the post |
| `Extracted At` | ISO timestamp of extraction |

---

## AI Titles (optional)

After extraction, the extension can call an AI API to generate a short, descriptive title (up to 8 words) for each post.

**Supported providers:**

| Provider | Model | Cost per 100 posts |
|----------|-------|--------------------|
| Anthropic | Claude Haiku 3.5 | ~$0.035 (range $0.02–$0.06) |
| OpenAI | GPT-4o mini | ~$0.006 (range $0.003–$0.012) |

**Getting an API key:**
- Anthropic: [platform.claude.com/dashboard](https://platform.claude.com/dashboard) → log in → API keys
- OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys) → log in → Create new secret key

**Privacy:** Your API key is stored only in Chrome's local extension storage on your device. It is never sent to any server other than Anthropic's or OpenAI's API directly from your browser.

You can add or change your API key at any time via the **⋯ menu** in the extension popup.

---

## Popup controls

| Control | Action |
|---------|--------|
| **Extract now** | Run an immediate extraction |
| **Stop** | Gracefully stop a running extraction (saves posts collected so far) |
| **AI Titles toggle** | Enable/disable AI title generation |
| **Anthropic / OpenAI buttons** | Switch provider |
| **⋯ menu → Add / Change API Key** | Open the API key dialog |
| **⋯ menu → Restart Session** | Clear all extracted URLs and start fresh from the top of your saved posts |
| **⋯ menu → Email Developer** | Opens `mailto:support@usetrove.app` |

---

## FAQ

**What is Trove?**
Trove is your personal knowledge repository capable of auto-syncing your saves from across the internet so you can use them for professional and personal work. Saves catch dust across multiple platforms and Trove's goal is surface them for better usage. The team behind Trove is excited about curated intelligence that each knowledge worker maintains and making that accessible for the AI-Era. 


**Does this violate LinkedIn's Terms of Service?**
LinkedIn's 8.2 prohibits automated data collection for commercial purposes. However this extension is localized to your machine (laptop) and uses your existing login session, appears as normal human browsing, and only accesses your own saved posts. Given the saved posts are your own bookmarks, the risk of enforcement for personal use is very low. That said, use it at your own discretion.

**Where are the logs?**
Open `chrome://extensions`, find **LinkedIn Saved Posts Extractor**, and click **Service worker** to open the DevTools console. All extraction events are logged there.

**What happens if Chrome closes mid-extraction?**
The extension saves progress after every batch of 10 posts. On the next run it picks up from the last completed batch. At most 10 posts may need to be re-extracted.

**Can I change the output folder after setup?**
Yes — open the extension popup and update the folder field there. Files will start saving to the new location on the next run.

---

## Project structure

```
chrome-extension-prod/
├── manifest.json        Chrome extension manifest (MV3)
├── background.js        Service worker — extraction flow, AI title generation, alarms
├── content.js           Injected into LinkedIn — DOM scraping, two-phase scroll
├── popup.html/js        Extension popup UI
├── onboarding.html/js   First-install setup page
├── state.js             Chrome storage schema + helpers
├── utils.js             CSV generation, timestamp parsing, download helper
└── icons/               Extension icons (16, 48, 128 px)
```

---

## Want this without the setup?

[Trove](https://www.usetrove.app) will be doing this natively — no extension, no API keys, no CSV wrangling. Your LinkedIn saved posts are automatically enriched, tagged, and searchable alongside everything else you've bookmarked so you can reference them inside of an AI chat (Claude, ChatGPT, Gemini)

---

## License

MIT — fork it, build on it, ship it. A mention or link back is appreciated.

Questions or bugs: [support@usetrove.app](mailto:support@usetrove.app)

## Discord Community

Join Trove's Beta launch: https://discord.gg/4jU4Myfvs

