# El – EchoMart Voice Shopping Assistant

**El** is a voice-powered shopping assistant built for EchoMart. Instead of browsing a website manually, customers can simply **talk** to El and she will help them find products, compare prices, and get a direct link to purchase — all through natural conversation.

---

## What El Can Do

- **Search for products by voice** — Ask El things like *"Show me your snowboards"* and she'll pull up real products from the store.
- **Find the best price** — Say *"What's the most expensive snowboard?"* or *"Show me the cheapest option"* and El will sort results by price for you.
- **Help you buy** — Tell El *"I want to buy The Complete Snowboard"* and she'll give you a direct link straight to that product's page so you can check out instantly.
- **Natural conversation** — El understands casual language. You don't have to use exact product names or filter menus.

---

## How It Works (Simple Version)

1. A customer clicks the **"Talk to El"** button on the EchoMart Shopify store.
2. El joins a live voice call with the customer via **Agora** (a real-time audio platform).
3. When the customer asks about products, El quietly queries the **Shopify Storefront API** in the background.
4. El speaks the results back to the customer naturally.

---

## Setup (for developers)

### 1. Fill in your credentials

```bash
cp .env.example .env.local
# open .env.local and fill in every value
```

| Variable | Where to get it |
|---|---|
| `AGORA_APP_ID` | Agora Console → project list |
| `AGORA_CUSTOMER_ID` | Console → RESTful API → Customer ID |
| `AGORA_CUSTOMER_SECRET` | Console → RESTful API → Customer Secret |
| `AGORA_RTC_TOKEN` | Console → Token Builder (UID=123, channel=echo-mart-dev) |
| `AGORA_PIPELINE_ID` | Agora Studio → your saved agent config |
| `NGROK_URL` | Output of `ngrok http 3000` (update each session) |
| `SHOPIFY_DOMAIN` | `your-store.myshopify.com` (no https://) |
| `SHOPIFY_STOREFRONT_TOKEN` | Shopify Admin → Apps → Develop apps → your app → Storefront API access token |

> **Important:** Your Shopify app needs the `unauthenticated_read_product_listings` scope enabled under its Storefront API configuration, otherwise product searches will return Unauthorized errors.

### 2. Install dependencies

```bash
npm install
```

### 3. Start ngrok first

```bash
ngrok http 3000
```

Copy the `https://xxxx.ngrok-free.app` URL and set it as `NGROK_URL` in `.env.local`.

### 4. Start the server

```bash
node server.js
```

### 5. Open your Shopify store and click "Talk to El"

El will join the voice channel and you can start shopping!

---

## Example Conversations

> **You:** "What snowboards do you have?"
> **El:** "We have The Complete Snowboard at $699.95, The Videographer Snowboard at $885.95, and more!"

> **You:** "Which one is the most expensive?"
> **El:** "The most expensive snowboard is The 3p Fulfilled Snowboard at $2,629.95."

> **You:** "I want to buy The Complete Snowboard."
> **El:** "Great choice! The Complete Snowboard is $699.95. Here is the link to purchase it: [link]"

---

## Tech Stack

| Layer | Technology |
|---|---|
| Voice AI | Agora Conversational AI v2.5 |
| Backend server | Node.js + Express |
| Product data | Shopify Storefront API (GraphQL) |
| Public tunnel | ngrok |
| Storefront | Shopify Liquid |


---

## Quick start (5-step sprint)

### 1. Fill in your credentials

```bash
cp .env.example .env.local
# open .env.local and fill in every value
```

| Variable | Where to get it |
|---|---|
| `AGORA_APP_ID` | Agora Console → project list |
| `AGORA_CUSTOMER_ID` | Console → RESTful API → Customer ID |
| `AGORA_CUSTOMER_SECRET` | Console → RESTful API → Customer Secret |
| `AGORA_RTC_TOKEN` | Console → Token Builder (UID=123, channel=echo-mart-dev) |
| `NGROK_URL` | Output of `ngrok http 3000` (update each session) |
| `SHOPIFY_DOMAIN` | `your-store.myshopify.com` |
| `SHOPIFY_STOREFRONT_TOKEN` | Shopify Admin → Apps → Storefront API |

### 2. Install dependencies

```bash
npm install
```

### 3. Start the server

```bash
node server.js
# or with auto-restart:
node --watch server.js
```

### 4. Expose it with ngrok

```bash
ngrok http 3000
```

Copy the `https://xxxx.ngrok-free.app` URL and paste it as `NGROK_URL` in `.env.local`, then **restart** `server.js`.

### 5. Update your Shopify Liquid button

Point the fetch call at:
```
https://xxxx.ngrok-free.app/api/start-el
```

---

## API Endpoints

### `POST /api/start-el`
Wakes El up and drops her into the Agora channel.

```json
// Request body (all optional — falls back to defaults)
{ "channel": "echo-mart-dev", "uid": "123" }

// Success
{ "agent_id": "...", "channel": "echo-mart-dev" }
```

### `POST /api/shopify-search`
Called automatically by El (via Agora's MCP mechanism) whenever she needs to search products.

```json
// Agora sends:
{ "arguments": { "query": "blue running shoes" } }

// Server returns:
{ "result": "Found 2 products: Nike Air Zoom at $89.99 USD; Adidas Ultraboost at $179.99 USD." }
```

### `GET /health`
Quick sanity check — returns `{ "status": "ok", "ngrok": "..." }`.

---

## Architecture notes

### Why `preset` not `llm.url`?

Agora v2.5 has a top-level `preset` field. Setting `preset: "openai_gpt_4o_mini"` removes the need to supply `llm.url`, `llm.api_key`, and `llm.params.model` manually.

### Why `mcp_servers`, not `tools[].url`?

The `tools[].url` format in the original cheat-sheet is a **legacy** pattern. Agora v2.5 uses the **MCP Streamable-HTTP** transport:

```json
"mcp_servers": [{
  "name": "echomart_catalog",
  "transport": "streamable_http",
  "endpoint": "https://xxxx.ngrok-free.app/api/shopify-search",
  "allowed_tools": ["search_catalog"]
}]
```

### Why `end_of_speech.mode: "semantic"` not `interrupt_mode: "adaptive"`?

`interrupt_mode` doesn't exist in v2.5. `"semantic"` end-of-speech is the equivalent of "adaptive" — it uses AI-based turn detection rather than a fixed silence timer.
