// ============================================================
//  El – EchoMart Voice Shopping Assistant
//  All-in-One Prototype Server
//  Usage:  node server.js
//          ngrok http 3000
// ============================================================

require('dotenv').config({ path: '.env.local' });        // loads .env.local explicitly
const express = require('express');
const cors = require('cors');    // <--- Add this
const axios = require('axios');

const app = express();

// ── Active agent tracker (keyed by channel) ─────────────────
// Maps channel → agent_id so we can stop the old agent before starting a new one.
const activeAgents = new Map();

async function stopAgent(channel) {
  const agentId = activeAgents.get(channel);
  if (!agentId) return;
  try {
    await axios.post(
      `https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}/agents/${agentId}/leave`,
      {},
      { headers: { Authorization: `Basic ${AGORA_AUTH}`, 'Content-Type': 'application/json' } }
    );
    console.log(`⏹️  Stopped agent ${agentId} on channel "${channel}"`);
  } catch (err) {
    // Ignore – agent may have already stopped on its own
    console.warn(`⚠️  Could not stop agent ${agentId}:`, err.response?.data?.message || err.message);
  }
  activeAgents.delete(channel);
}

// ── Per-channel pending cart actions (polled by widget) ──────
// The LLM reformulates MCP tool responses, so [CART_ADD:...] tokens never
// reliably reach the widget via RTM. Instead we queue actions here and let
// the widget poll GET /api/cart-actions to drain them.
const pendingActions = new Map();          // channel → Action[]
function getPending(channel) {
  if (!pendingActions.has(channel)) pendingActions.set(channel, []);
  return pendingActions.get(channel);
}

// Browser pushes live cart state here after each AJAX cart operation.
// El's get_cart tool reads from this instead of a shadow map.
const cartStates = new Map();              // channel → CartItem[]

// 1. Enable CORS for all origins (with explicit pre-flight handling)
app.options('*', cors());   // respond to OPTIONS preflight for every route
app.use(cors());

// 2. Keep your ngrok bypass header
app.use((_req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

app.use(express.json());

// ── Configuration (all values come from .env.local) ─────────
const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_AUTH = Buffer.from(
  `${process.env.AGORA_CUSTOMER_ID}:${process.env.AGORA_CUSTOMER_SECRET}`
).toString('base64');

const AGORA_RTC_TOKEN = process.env.AGORA_RTC_TOKEN;
const AGORA_PIPELINE_ID = process.env.AGORA_PIPELINE_ID; // stores your Deepgram/OpenAI/MiniMax keys
const NGROK_URL = process.env.NGROK_URL;

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;       // your-store.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN; // shpat_xxxx

// ── Startup guard ────────────────────────────────────────────
const REQUIRED_VARS = [
  'AGORA_APP_ID', 'AGORA_CUSTOMER_ID', 'AGORA_CUSTOMER_SECRET',
  'AGORA_RTC_TOKEN', 'AGORA_PIPELINE_ID', 'NGROK_URL', 'SHOPIFY_DOMAIN', 'SHOPIFY_STOREFRONT_TOKEN',
];
const missing = REQUIRED_VARS.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌  Missing env vars:', missing.join(', '));
  console.error('    Copy .env.example → .env.local and fill them in.');
  process.exit(1);
}

// ============================================================
//  ENDPOINT 1: /api/start-el
//  Called by the "Wake El" button in your Shopify Liquid code.
// ============================================================
app.post('/api/start-el', async (req, res) => {
  // Accept optional overrides from the frontend; fall back to your Studio defaults
  const channel = req.body?.channel || 'echo-mart-dev';
  const remoteUid = '123';   // must match uid in Liquid code

  // Stop any existing agent on this channel first (prevents agent stacking)
  await stopAgent(channel);
  console.log(`\n🟢  /api/start-el  channel="${channel}"  remoteUid="${remoteUid}"  (previous agent stopped)`);
  // Note: shadow cart intentionally persists across sessions so El remembers added items.

  // ── Agora v2.5 Join payload ───────────────────────────────
  // Mirrors your curl exactly. pipeline_id pulls the saved agent config
  // Mirrors your curl exactly.
  const agoraPayload = {
    name: `El_Assistant_${Date.now()}`,  // must be unique per-call
    pipeline_id: AGORA_PIPELINE_ID,     // ← holds your Deepgram/OpenAI/MiniMax credentials

    properties: {
      channel,
      token: AGORA_RTC_TOKEN,
      agent_rtc_uid: '999',          // must match the UID the AGORA_RTC_TOKEN was generated for
      remote_rtc_uids: [remoteUid],
      enable_string_uid: false,
      idle_timeout: 120,

      asr: {
        params: {},
        vendor: "ares",
        language: "en-US"
      },

      llm: {
        url: 'https://api.openai.com/v1/chat/completions',
        vendor: 'openai',
        params: { model: 'gpt-4.1-mini' },
        failure_message: 'Please hold on a second.',
        system_messages: [{
          role: 'system',
          content: [
            '## 1. Identity',
            'Your name is El. You are a helpful, professional, and friendly shopping assistant for EchoMart.',
            'You specialize in real-time voice commerce.',
            '',
            '## 2. Voice Guidelines (CRITICAL for Voice AI)',
            '- Be CONCISE: Keep responses under 2 sentences. This is a voice conversation; nobody likes long speeches.',
            '- Use natural filler words sparingly: (e.g., "Got it," "Sure," "Let me check that for you.")',
            '- If you don\'t hear the user clearly, say: "I\'m sorry, I didn\'t catch that. Could you say that again?"',
            '',
            '## 3. Tasks & Logic',
            '- SEARCH: Always use the \'search_catalog\' tool to find products. Never hallucinate prices or availability.',
            '- RECOMMEND: If a user is unsure, suggest 2 items and mention their key benefits.',
            '- CART – Add: When a user says "buy" or "add to cart," call \'create_cart\'. The item will be added to the shopper\'s Shopify cart automatically.',
            '- CART – View: If a user asks "what is in my cart" or "show my cart," call \'get_cart\'.',
            '- CART – Update quantity: If a user says "change the quantity" or "update", call \'update_cart_item\' with the variant_id (from get_cart) and the new quantity.',
            '- CART – Remove: If a user says "remove" or "delete from cart", call \'remove_from_cart\' with the variant_id (from get_cart).',
            '- After any cart action, confirm with ONE very short sentence (e.g., "Done! Added to your cart."). Never mention technical IDs, tokens, or URLs to the user.',
            '- IMAGES: Product images are shown automatically in the chat. NEVER say you cannot show images. If asked about appearance, just describe the product briefly.',
            '- ORDERS: For tracking, ask for their Order ID and verify it using the \'get_order_status\' tool.',
            '',
            '## 4. Guardrails',
            '- Only answer queries related to EchoMart products and orders.',
            '- If a user asks something unrelated, gently redirect them: "I\'d love to help with that, but I\'m here to help you shop at EchoMart. Anything else you\'re looking for?"',
            '- DO NOT make up coupons or discounts unless the system provides them.',
          ].join('\n'),
        }],
        greeting_message: 'Welcome! I am El, your personal shopping assistant. How can I help you?',

        // ── Tool: search_catalog ────────────────────────────────
        // Agora calls this MCP endpoint when El invokes search_catalog.
        // The endpoint below implements the MCP Streamable-HTTP protocol.
        mcp_servers: [{
          name: 'echomart-catalog',
          transport: 'streamable_http',
          endpoint: `${NGROK_URL}/api/shopify-search`,
          allowed_tools: ['search_catalog', 'create_cart', 'get_cart', 'update_cart_item', 'remove_from_cart'],
        }],
      },

      tts: {
        vendor: 'minimax',
        params: {
          url: 'wss://api-uw.minimax.io/ws/v1/t2a_v2',
          model: 'speech-2.8-turbo',
          voice_setting: {
            voice_id: 'English_radiant_girl',
          },
        },
      },

      sal: {
        sal_mode: 'locking',
        sample_urls: {},
      },

      turn_detection: null,   // use Agora Studio default

      // Explicitly override any pipeline-level silence_config so El never
      // sends an "are you still there?" prompt during silence.
      // action:'think' with empty content = LLM gets no prompt, stays silent.
      parameters: {
        silence_config: {
          action: 'think',
          content: '',
          timeout_ms: 300000,   // 5 minutes — effectively disabled
        },
      },

      advanced_features: {
        enable_rtm: true,
        enable_sal: true,
        enable_tools: true,   // required for MCP tool invocation
      },
    },
  };

  try {
    const response = await axios.post(
      `https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}/join`,
      agoraPayload,
      {
        headers: {
          Authorization: `Basic ${AGORA_AUTH}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('✅  Agora agent started:', response.data);
    // Track this agent so we can stop it later
    activeAgents.set(channel, response.data.agent_id);
    res.json(response.data);

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌  Agora error:', JSON.stringify(detail, null, 2));
    res.status(500).json({ error: 'Failed to start El', detail });
  }
});

// ============================================================
//  ENDPOINT: /api/stop-el
//  Called by the widget when the user clicks Stop.
// ============================================================
app.post('/api/stop-el', async (req, res) => {
  const channel = req.body?.channel || 'echo-mart-dev';
  await stopAgent(channel);
  res.json({ ok: true });
});

// ============================================================
//  ENDPOINT 2: /api/shopify-search  (MCP Streamable-HTTP)
//  Implements the full MCP JSON-RPC handshake Agora requires:
//    initialize → tools/list → tools/call
// ============================================================
app.post('/api/shopify-search', async (req, res) => {
  const { method, params, id } = req.body || {};

  // Log every incoming request so we can see what Agora sends
  console.log(`\n📨  MCP request → method: "${method}" id: ${id}`);
  if (params) console.log('    params:', JSON.stringify(params, null, 2));

  // ── MCP: initialize handshake (Agora sends this first) ─────
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'echomart-catalog', version: '1.0.0' },
      },
    });
  }

  // ── MCP: initialized notification (no response needed) ──────
  if (method === 'notifications/initialized') {
    return res.status(200).end();
  }

  // ── MCP: tool discovery ────────────────────────────────────
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'search_catalog',
            description: 'Search EchoMart products. Supports price queries like "most expensive" or "cheapest".',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search term, e.g. "snowboard" or "most expensive snowboard"' },
              },
              required: ['query'],
            },
          },
          {
            name: 'create_cart',
            description: 'Add a product to the shopper\'s cart. Looks up the product, then signals the browser to add it via the Shopify AJAX API so the theme cart updates in real time.',
            inputSchema: {
              type: 'object',
              properties: {
                product_title: { type: 'string', description: 'The product title to add to cart' },
                quantity: { type: 'number', description: 'How many to add (default: 1)' },
                channel: { type: 'string', description: 'Session channel name (default: echo-mart-dev)' },
              },
              required: ['product_title'],
            },
          },
          {
            name: 'get_cart',
            description: 'List the current contents of the shopper\'s cart.',
            inputSchema: {
              type: 'object',
              properties: {
                channel: { type: 'string', description: 'Session channel name (default: echo-mart-dev)' },
              },
              required: [],
            },
          },
          {
            name: 'update_cart_item',
            description: 'Update the quantity of a product already in the cart.',
            inputSchema: {
              type: 'object',
              properties: {
                variant_id: { type: 'string', description: 'The numeric Shopify variant ID (returned by get_cart)' },
                quantity: { type: 'number', description: 'New quantity (set to 0 to remove)' },
                channel: { type: 'string', description: 'Session channel name (default: echo-mart-dev)' },
              },
              required: ['variant_id', 'quantity'],
            },
          },
          {
            name: 'remove_from_cart',
            description: 'Remove a product from the cart entirely.',
            inputSchema: {
              type: 'object',
              properties: {
                variant_id: { type: 'string', description: 'The numeric Shopify variant ID to remove (from get_cart)' },
                channel: { type: 'string', description: 'Session channel name (default: echo-mart-dev)' },
              },
              required: ['variant_id'],
            },
          },
        ],
      },
    });
  }

  // ── MCP: search_catalog ────────�    // ── Detect price intent — use Shopify API-level sorting ──────
  if (method === 'tools/call' && params && params.name === 'search_catalog') {
    const query = (params.arguments && params.arguments.query) || '';
    console.log('[search] query:', query);

    if (!query.trim()) {
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: "Please tell me what you're looking for." }] } });
    }

    const isExpensive = /expensive|most expensive|priciest|highest price/i.test(query);
    const isCheapest = /cheap|cheapest|lowest price|affordable|budget/i.test(query);
    const sortKey = (isExpensive || isCheapest) ? 'PRICE' : 'RELEVANCE';
    const reverse = isExpensive;   // true = most expensive first

    // Strip price adjectives so Shopify searches by product type
    const searchTerm = query
      .replace(/most expensive|expensive|priciest|highest price|cheapest|cheap|lowest price|affordable|budget/gi, '')
      .trim();

    const gql = {
      query: `{
        products(
          first: 5,
          sortKey: ${sortKey},
          reverse: ${reverse}${searchTerm ? `,\n          query: "${searchTerm.replace(/"/g, '\\"')}"` : ''}
        ) {
          nodes {
            title
            handle
            featuredImage { url altText }
            variants(first: 1) {
              nodes {
                id
                price { amount currencyCode }
              }
            }
          }
        }
      }`,
    };

    try {
      const sfRes = await axios.post(
        `https://${SHOPIFY_DOMAIN}/api/2025-04/graphql.json`,
        gql,
        { headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN } }
      );

      if (sfRes.data?.errors) {
        console.error('❌  Storefront API errors:', JSON.stringify(sfRes.data.errors, null, 2));
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'The store is unavailable right now. Please try again.' }] } });
      }

      const nodes = (sfRes.data?.data?.products?.nodes || []).filter(p => p.title).slice(0, 3);

      const lines = nodes.map(p => {
        const price = p.variants?.nodes?.[0]?.price;
        const priceStr = price ? `$${parseFloat(price.amount).toFixed(2)} ${price.currencyCode}` : 'price unavailable';
        return `${p.title} at ${priceStr}`;
      });

      // Embed image token for the top result — widget strips it from bubble but renders a product card
      // Format: [PRODUCT_IMG:imageUrl|title|price]
      let imgToken = '';
      const topNode = nodes[0];
      if (topNode?.featuredImage?.url) {
        const price = topNode.variants?.nodes?.[0]?.price;
        const priceStr = price ? `$${parseFloat(price.amount).toFixed(2)} ${price.currencyCode}` : '';
        imgToken = ` [PRODUCT_IMG:${topNode.featuredImage.url}|${topNode.title}|${priceStr}]`;
        console.log('🖼️  Image token attached:', topNode.title);

        // Also queue a show_product action so the widget shows the card via polling
        // (LLM reformulates tool text so the token never reaches the widget via stream-message)
        const channel = (params.arguments && params.arguments.channel) || 'echo-mart-dev';
        getPending(channel).push({
          type: 'show_product',
          imageUrl: topNode.featuredImage.url,
          imageAlt: topNode.featuredImage.altText || topNode.title,
          title: topNode.title,
          price: priceStr,
        });
        console.log('📦  show_product queued for channel:', channel);
      }

      const text = (lines.length
        ? lines.join('; ')
        : 'No matching products found. Try searching for snowboard or wax.') + imgToken;

      console.log('✅  Shopify result:', text);
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error('❌  Shopify error:', JSON.stringify(detail, null, 2));
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'I had trouble searching the store. Please try again.' }] } });
    }
  } // end search_catalog

  // ── MCP: create_cart – signals widget to call AJAX /cart/add.js ────────
  if (method === 'tools/call' && params && params.name === 'create_cart') {
    const productTitle = (params.arguments && params.arguments.product_title) || '';
    const quantity = parseInt((params.arguments && params.arguments.quantity) || 1, 10) || 1;
    const channel = (params.arguments && params.arguments.channel) || 'echo-mart-dev';
    console.log('[cart:add] product="' + productTitle + '" qty=' + quantity + ' channel=' + channel);

    try {
      // Look up the variant ID and available quantity
      const searchGql = {
        query: '{ products(first: 1, query: "title:' + productTitle.replace(/"/g, '\\"') + '") { nodes { title handle variants(first: 1) { nodes { id quantityAvailable price { amount currencyCode } } } } } }',
      };
      const searchRes = await axios.post(
        'https://' + SHOPIFY_DOMAIN + '/api/2025-04/graphql.json',
        searchGql,
        { headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN } }
      );

      const product = searchRes.data?.data?.products?.nodes?.[0];
      if (!product) {
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'I could not find "' + productTitle + '" in the store. Please try the exact product name.' }] } });
      }

      const variantNode = product.variants?.nodes?.[0];
      const variantGid = variantNode?.id;
      const qtyAvailable = variantNode?.quantityAvailable;

      console.log('[cart:add] Variant found:', variantGid);
      console.log('[cart:add] Quantity available from Shopify:', qtyAvailable);

      if (!variantGid) {
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: product.title + ' has no purchasable variant right now.' }] } });
      }

      // ── Inventory Check ────────────────────────────────────────────────
      if (qtyAvailable !== null && qtyAvailable !== undefined) {
        console.log('[cart:add] Performing inventory check for:', product.title);
        if (qtyAvailable <= 0) {
          console.log('[cart:add] Out of stock!');
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Sorry, ' + product.title + ' is currently out of stock.' }] } });
        }
        if (quantity > qtyAvailable) {
          console.log('[cart:add] Insufficient stock. Available:', qtyAvailable, 'Requested:', quantity);
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'You asked for ' + quantity + ', but we only have ' + qtyAvailable + ' ' + product.title + ' in stock. Please let me know if you want to add the available amount.' }] } });
        }
      }

      // Extract the numeric variant ID (AJAX API needs this, not the GID)
      const numericVariantId = variantGid.split('/').pop();
      const priceNode = variantNode?.price;
      const unitPrice = priceNode ? ('$' + parseFloat(priceNode.amount).toFixed(2) + ' ' + priceNode.currencyCode) : '';

      // Queue a cart action for the widget to execute via /cart/add.js
      getPending(channel).push({ type: 'add', variantId: numericVariantId, qty: quantity });
      console.log('[cart:add] action queued. variantId=' + numericVariantId + ' qty=' + quantity);

      const text = 'I have added ' + quantity + ' x ' + product.title
        + (unitPrice ? ' at ' + unitPrice + ' each' : '') + '.';

      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error('[cart:add] error:', JSON.stringify(detail, null, 2));
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'I had trouble adding that to your cart. Please try again.' }] } });
    }
  }

  // ── MCP: get_cart – reads cart state pushed by the browser ────
  if (method === 'tools/call' && params && params.name === 'get_cart') {
    const channel = (params.arguments && params.arguments.channel) || 'echo-mart-dev';
    const state = cartStates.get(channel);
    console.log('[get_cart] channel:', channel, 'state items:', state ? state.length : 0);

    if (!state || state.length === 0) {
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Your cart is empty. Would you like me to find something for you?' }] } });
    }

    const items = state.map(i =>
      `${i.quantity} x ${i.title}${i.price ? ' at ' + i.price : ''}${i.variant_id ? ' (variant_id: ' + i.variant_id + ')' : ''}`
    );
    const text = 'Your cart contains: ' + items.join('; ') + '. You can say "remove" or "update quantity" for any item.';
    console.log('[get_cart] result:', text);
    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  }

  // ── MCP: update_cart_item – signals widget to call AJAX /cart/update.js ─
  if (method === 'tools/call' && params && params.name === 'update_cart_item') {
    const channel = (params.arguments && params.arguments.channel) || 'echo-mart-dev';
    const variantId = (params.arguments && params.arguments.variant_id) || '';
    const newQty = parseInt((params.arguments && params.arguments.quantity) || 1, 10);

    if (!variantId) {
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Please tell me which product to update. Try asking "what is in my cart" first.' }] } });
    }
    console.log('[update_cart_item] variantId:', variantId, 'qty:', newQty, 'channel:', channel);

    // Queue action for widget to execute via /cart/update.js
    getPending(channel).push({ type: 'update', variantId, qty: newQty });
    console.log('[update_cart_item] action queued variantId=' + variantId + ' qty=' + newQty);

    const text = newQty <= 0
      ? 'Done! I removed that item from your cart.'
      : 'Done! I updated the quantity to ' + newQty + '.';

    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  }

  // ── MCP: remove_from_cart – signals widget to call AJAX /cart/update.js ─
  if (method === 'tools/call' && params && params.name === 'remove_from_cart') {
    const channel = (params.arguments && params.arguments.channel) || 'echo-mart-dev';
    const variantId = (params.arguments && params.arguments.variant_id) || '';

    if (!variantId) {
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Please tell me which product to remove. Try asking "what is in my cart" first.' }] } });
    }
    console.log('[remove_from_cart] variantId:', variantId, 'channel:', channel);

    // Queue action for widget to execute via /cart/update.js (qty 0 = remove)
    getPending(channel).push({ type: 'update', variantId, qty: 0 });
    console.log('[remove_from_cart] action queued variantId=' + variantId);

    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Done! I removed that item from your cart.' }] } });
  }

  res.status(400).json({
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});

// ─────────────────────────────────────────────────────────────
//  GET /api/cart-actions?channel=...
//  Widget polls this every 1.5 s. Returns queued actions and drains.
// ─────────────────────────────────────────────────────────────
app.get('/api/cart-actions', (req, res) => {
  const channel = (req.query.channel || 'echo-mart-dev').trim();
  const actions = pendingActions.get(channel) || [];
  pendingActions.set(channel, []);   // drain
  if (actions.length) console.log(`[cart-actions] channel="${channel}" returning ${actions.length} action(s)`);
  res.json({ actions });
});

// ─────────────────────────────────────────────────────────────
//  POST /api/cart-state?channel=...
//  Widget POSTs its live Shopify cart (from /cart.js) after every
//  add/update/remove so El's get_cart tool has accurate data.
// ─────────────────────────────────────────────────────────────
app.post('/api/cart-state', (req, res) => {
  const channel = (req.query.channel || req.body?.channel || 'echo-mart-dev').trim();
  const items = req.body?.items || [];
  cartStates.set(channel, items);
  console.log(`[cart-state] channel="${channel}" updated: ${items.length} item(s)`);
  res.json({ ok: true });
});
// GET /api/product-image?q=<title>
// Uses Storefront API for read-only product metadata (image, price)
app.get('/api/product-image', async (req, res) => {
  const query = (req.query.q || '').trim();
  const shopifyQuery = `title:${query.replace(/"/g, '\\"')}`;
  console.log(`[product-image] incoming q="${query}"`);
  console.log(`[product-image] Shopify GQL query → products(query: "${shopifyQuery}")`);
  if (!query) return res.json({ found: false });
  try {
    const gql = {
      query: `{
        products(first: 1, query: "${shopifyQuery}") {
          nodes {
            title
            handle
            featuredImage { url altText }
            variants(first: 1) {
              nodes { price { amount currencyCode } }
            }
          }
        }
      }`,
    };
    const sfRes = await axios.post(
      `https://${SHOPIFY_DOMAIN}/api/2025-04/graphql.json`,
      gql,
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN } }
    );
    const product = sfRes.data?.data?.products?.nodes?.[0];
    if (!product) return res.json({ found: false });
    const variant = product.variants?.nodes?.[0];
    return res.json({
      found: true,
      title: product.title,
      handle: product.handle,
      imageUrl: product.featuredImage?.url || null,
      imageAlt: product.featuredImage?.altText || product.title,
      price: variant?.price
        ? `$${parseFloat(variant.price.amount).toFixed(2)} ${variant.price.currencyCode}`
        : null,
    });
  } catch (err) {
    console.error('[product-image] error:', err.message);
    return res.json({ found: false });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ngrok: NGROK_URL }));

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  El prototype server running on http://localhost:${PORT}`);
  console.log(`    Ngrok URL: ${NGROK_URL}`);
  console.log(`    Search tool endpoint: ${NGROK_URL}/api/shopify-search\n`);
});