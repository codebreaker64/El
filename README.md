# El – EchoMart Voice Shopping Assistant

Local Express prototype that glues **Agora Conversational AI v2.5** to your Shopify Storefront API via ngrok.

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
| `ELEVENLABS_API_KEY` | ElevenLabs dashboard |
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
