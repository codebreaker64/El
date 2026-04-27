# El – EchoMart Voice Shopping Assistant

**El** is a voice-powered shopping assistant embedded directly in an EchoMart Shopify storefront. Customers simply **talk** to El and she finds products, manages their cart in real time, and answers questions, all through natural voice conversation.

---

## What El Can Do

| Voice Command | What Happens |
|---|---|
| *"Show me your snowboards"* | El queries Shopify and reads back matching products |
| *"What's the cheapest option?"* | El re-sorts results by price ascending |
| *"Add The Complete Snowboard to my cart"* | El signals the browser to call `/cart/add.js` — the Shopify theme cart updates instantly |
| *"What's in my cart?"* | El reads out every item, quantity, and price |
| *"Update the quantity to 2"* | El calls `/cart/update.js` with the correct variant ID |
| *"Remove the snowboard"* | El sets quantity to 0 via `/cart/update.js` |
| *"Track my order #12345"* | El fetches order status via `get_order_status` |

---

## Architecture Overview

```
Browser (Shopify storefront)          Express Server (this repo)
┌─────────────────────────┐           ┌──────────────────────────────┐
│  el-widget.liquid       │  HTTP     │  server.js                   │
│  ├─ AgoraRTC client     │◄─────────►│  ├─ POST /api/start-el       │
│  ├─ Cart polling loop   │           │  ├─ POST /api/stop-el         │
│  └─ Shopify AJAX cart   │           │  ├─ POST /api/shopify-search  │◄── Agora MCP
└─────────────────────────┘           │  ├─ GET  /api/cart-actions    │
           │ RTC audio                │  ├─ POST /api/cart-state      │
           ▼                          │  ├─ POST /api/report-sold-out │
   ┌───────────────┐                  │  └─ GET  /api/product-image   │
   │  Agora Cloud  │                  └──────────────────────────────┘
   │  (voice AI)   │                             │
   └───────────────┘                             ▼
           │ MCP call                  ┌──────────────────┐
           └─────────────────────────►│  Shopify          │
                                       │  Storefront API  │
                                       └──────────────────┘
```

### Key Design Decisions

**Cart sync via polling, not RTM tokens**
El's LLM reformulates MCP tool results in its own words, so `[CART_ADD:...]` tokens embedded in tool responses never reliably reach the browser via the RTM stream. Instead, the server queues cart actions (`pendingActions` map) and the widget polls `GET /api/cart-actions` every 1.5 s to drain and execute them.

**Live cart state pushed by the browser**
After every AJAX cart operation, the widget POSTs the current `/cart.js` snapshot to `POST /api/cart-state`. El's `get_cart` tool reads from this server-side cache instead of querying Shopify directly, ensuring she always knows what's actually in the shopper's basket.

**AI message buffering**
Agora streams the AI response incrementally — each packet contains the *full accumulated text so far*. The widget silently buffers incoming packets and only commits the bubble to the chat once the stream goes quiet for 900 ms, so the user always sees the complete message.

**Bundled section rendering**
Cart AJAX calls include a `sections` parameter so Shopify returns updated HTML for the cart badge and drawer in the same response. The widget surgically replaces only the inner DOM nodes, preserving existing event listeners.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Voice AI | Agora Conversational AI v2 (MCP Streamable-HTTP) |
| LLM | OpenAI GPT-4.1 Mini |
| ASR | Agora Ares |
| TTS | MiniMax Speech 2.8 Turbo |
| Backend | Node.js 22 + Express 4 |
| Product data | Shopify Storefront GraphQL API (2025-04) |
| Public tunnel | ngrok |
| Storefront | Shopify Liquid section |

---

## Setup

### Prerequisites

- Node.js 18+
- An [Agora](https://console.agora.io) account with a Conversational AI pipeline configured
- A Shopify store with a custom app that has `unauthenticated_read_product_listings` scope
- [ngrok](https://ngrok.com) installed

### 1. Clone and install

```bash
git clone https://github.com/your-org/El.git
cd El
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
# Fill in every value (see table below)
```

| Variable | Where to get it |
|---|---|
| `AGORA_APP_ID` | Agora Console → project list |
| `AGORA_CUSTOMER_ID` | Console → RESTful API → Customer ID |
| `AGORA_CUSTOMER_SECRET` | Console → RESTful API → Customer Secret |
| `AGORA_RTC_TOKEN` | Console → Token Builder (UID=`123`, channel=`echo-mart-dev`) |
| `AGORA_PIPELINE_ID` | Agora Studio → your saved agent pipeline |
| `NGROK_URL` | Output of `ngrok http 3000` — update each session |
| `SHOPIFY_DOMAIN` | `your-store.myshopify.com` (no `https://`) |
| `SHOPIFY_STOREFRONT_TOKEN` | Shopify Admin → Apps → Develop apps → your app → Storefront API access token |

> **Important:** Your Shopify app must have `unauthenticated_read_product_listings` (and `unauthenticated_write_checkouts` if using cart) enabled under Storefront API scopes.

### 3. Start ngrok

```bash
ngrok http 3000
```

Copy the `https://xxxx.ngrok-free.app` URL into `NGROK_URL` in `.env.local`.

### 4. Start the server

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

You should see:
```
🚀  El prototype server running on http://localhost:3000
    Ngrok URL: https://xxxx.ngrok-free.app
    Search tool endpoint: https://xxxx.ngrok-free.app/api/shopify-search
```

### 5. Add the widget to Shopify

1. In Shopify Admin → **Online Store → Themes → Edit code**
2. Create a new section: `sections/el-widget.liquid`
3. Paste the full contents of `el-widget.liquid`
4. Update the three config constants near the top of the `<script>` block:

```javascript
const AGORA_APP_ID  = "YOUR_AGORA_APP_ID";
const AGORA_TOKEN   = "YOUR_RTC_TOKEN";       // regenerate each session
const BACKEND_URL   = "https://xxxx.ngrok-free.app";
```

5. In **Theme Editor**, add the **El Widget** section to your homepage or all pages via `theme.liquid`

---

## API Endpoints

### `POST /api/start-el`
Wakes El and drops her into the Agora RTC channel. Stops any previously running agent on the same channel first.

```json
// Request
{ "channel": "echo-mart-dev" }

// Success
{ "agent_id": "abc123", "status": "running" }
```

### `POST /api/stop-el`
Gracefully removes the Agora agent from the channel.

```json
{ "channel": "echo-mart-dev" }
```

### `POST /api/shopify-search` *(MCP endpoint)*
Implements the full MCP JSON-RPC handshake (`initialize → tools/list → tools/call`). Called automatically by Agora when El invokes any MCP tool.

**Tools exposed:**
- `search_catalog` — full-text + price-sorted product search
- `create_cart` — resolves variant ID, checks inventory, queues `add` action
- `get_cart` — reads live cart state pushed by the browser
- `update_cart_item` — validates stock, queues `update` action
- `remove_from_cart` — queues `update` action with qty=0

### `GET /api/cart-actions?channel=echo-mart-dev`
Returns queued cart actions and drains the queue. Polled by the widget every 1.5 s.

```json
{ "actions": [{ "type": "add", "variantId": "12345678", "qty": 1 }] }
```

### `POST /api/cart-state?channel=echo-mart-dev`
Browser pushes its live `/cart.js` snapshot here after every cart mutation.

```json
{ "items": [{ "variant_id": "12345678", "title": "Complete Snowboard", "quantity": 1, "price": "$699.95" }] }
```

### `POST /api/report-sold-out`
Widget calls this when Shopify AJAX returns a "sold out" error. El will remember and block future add attempts for this variant.

```json
{ "variantId": "12345678" }
```

### `GET /api/product-image?q=<title>`
Fetches product image, handle, and price for a given title. Used by the widget to render inline product cards.

### `GET /health`
```json
{ "status": "ok", "ngrok": "https://xxxx.ngrok-free.app" }
```

---

### Sample voice interactions to try

**Product discovery**
```
You:  "What snowboards do you have?"
El:   "We have The Complete Snowboard at $699.95, The Videographer Snowboard at $885.95, and The Mammoth Snowboard at $749.95."
```

**Price-based search**
```
You:  "Show me the most expensive snowboard"
El:   "The most expensive snowboard is The 3p Fulfilled Snowboard at $2,629.95."
```

**Add to cart**
```
You:  "Add The Complete Snowboard to my cart"
El:   "Done! Added to your cart."
      [Cart badge on the page updates immediately]
```

**View cart**
```
You:  "What's in my cart?"
El:   "Your cart contains: 1 x The Complete Snowboard at $699.95. You can say remove or update quantity for any item."
```

**Update quantity**
```
You:  "Change the quantity to 2"
El:   "I've updated the quantity to 2 for you."
```

**Remove item**
```
You:  "Remove the snowboard"
El:   "I've removed that item from your cart."
```

### Testing the server directly

```bash
# Health check
curl http://localhost:3000/health

# Start El manually
curl -X POST http://localhost:3000/api/start-el \
  -H "Content-Type: application/json" \
  -d '{"channel": "echo-mart-dev"}'

# Search products
curl -X POST http://localhost:3000/api/shopify-search \
  -H "Content-Type: application/json" \
  -d '{"method":"tools/call","id":1,"params":{"name":"search_catalog","arguments":{"query":"snowboard"}}}'

# Check queued cart actions
curl "http://localhost:3000/api/cart-actions?channel=echo-mart-dev"
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `❌ Missing env vars` on startup | Fill in all values in `.env.local` |
| El can't hear you / no audio | Check browser microphone permissions |
| Cart badge doesn't update | Ensure `cart-icon-bubble` is the correct section ID for your theme (Dawn assumed) |
| Products not found | Verify `SHOPIFY_STOREFRONT_TOKEN` has `unauthenticated_read_product_listings` scope |
| `401 Unauthorized` from Agora | Regenerate `AGORA_RTC_TOKEN` — tokens expire |
| ngrok URL changed | Update `NGROK_URL` in `.env.local` AND `BACKEND_URL` in the Liquid widget, then restart server |
