// ============================================================
//  El – EchoMart Voice Shopping Assistant
//  All-in-One Prototype Server
//  Usage:  node server.js
//          ngrok http 3000
// ============================================================

require('dotenv').config({ path: '.env.local' });
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// ── Active agent tracker (keyed by channel) ─────────────────
// Maps channel name → Agora agent_id.
// Prevents "ghost" agents if the user clicks Start twice — we always stop
// the previous agent before spawning a new one on the same channel.
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
    console.warn(`⚠️  Could not stop agent ${agentId}:`, err.response?.data?.message || err.message);
  }
  activeAgents.delete(channel);
}

// ── Per-channel pending cart actions (polled by widget) ──────
// WHY POLLING INSTEAD OF RTM:
// El's LLM rewrites MCP tool results in its own words before sending them
// to the browser via the RTM stream. Any [CART_ADD:...] tokens embedded in
// the original tool response are stripped/reworded and never reliably arrive.
// Solution: server queues actions here; widget polls GET /api/cart-actions
// every 1.5 s and executes them against the Shopify AJAX API directly.
const pendingActions = new Map();

/** Returns (and lazily creates) the action queue for a given channel. */
function getPending(channel) {
  if (!pendingActions.has(channel)) pendingActions.set(channel, []);
  return pendingActions.get(channel);
}

// Live cart state pushed by the browser after every AJAX cart operation.
// El's get_cart MCP tool reads from this map so it always reflects the
// shopper's actual Shopify cart without needing a server-side session.
const cartStates = new Map();

// Variant IDs that the browser has reported as "sold out" via the AJAX API.
// create_cart checks this set to give El immediate feedback without
// needing to re-query Shopify for every add attempt.
const knownSoldOut = new Set();

// Allow cross-origin requests — the Shopify storefront is on a different origin.
app.options('*', cors());
app.use(cors());

// ngrok intercepts browser requests and shows a warning page unless this header is set.
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
const AGORA_PIPELINE_ID = process.env.AGORA_PIPELINE_ID;
const NGROK_URL = process.env.NGROK_URL;

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

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

  // channel — Agora RTC channel name; must match the one the browser joins.
  // remoteUid — numeric UID the browser client uses (hardcoded to '123');
  //             El's agent only talks to this UID.
  const channel = req.body?.channel || 'echo-mart-dev';
  const remoteUid = '123';

  // Stop any existing agent on this channel before starting a fresh one.
  // Without this, clicking "Start" twice would launch two simultaneous agents.
  await stopAgent(channel);
  console.log(`\n🟢  /api/start-el  channel="${channel}"  remoteUid="${remoteUid}"  (previous agent stopped)`);

  // ── Agora Conversational AI agent join payload ───────────
  // pipeline_id points to the saved Agora Studio pipeline that wires
  // together ASR → LLM → TTS and the MCP tool configuration.
  const agoraPayload = {
    name: `El_Assistant_${Date.now()}`,  // unique name per session for tracing
    pipeline_id: AGORA_PIPELINE_ID,

    properties: {
      channel,
      token: AGORA_RTC_TOKEN,
      agent_rtc_uid: '999',             // El's own numeric UID in the channel
      remote_rtc_uids: [remoteUid],     // only listen to / speak to this user
      enable_string_uid: false,
      idle_timeout: 120,                // auto-leave after 120 s of silence

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

        // ── MCP server config ────────────────────────────────────
        // Agora uses the MCP Streamable-HTTP transport to call our tools.
        // When El decides to invoke a tool, Agora sends a JSON-RPC POST
        // to this endpoint (initialize → tools/list → tools/call sequence).
        // allowed_tools is an allowlist so the LLM cannot call any tool
        // that isn't explicitly listed here.
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

      turn_detection: null,

      parameters: {
        silence_config: {
          action: 'think',
          content: '',
          timeout_ms: 300000,
        },
      },

      advanced_features: {
        enable_rtm: true,
        enable_sal: true,
        enable_tools: true,
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

  console.log(`\n📨  MCP request → method: "${method}" id: ${id}`);
  if (params) console.log('    params:', JSON.stringify(params, null, 2));

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

  // ── MCP: search_catalog ────────────────────────────────────
  // Receives a free-text query from El (e.g. "most expensive snowboard").
  // Detects price-intent keywords to set Shopify's sortKey/reverse flags,
  // then strips those adjectives before passing the term to the GraphQL API.
  if (method === 'tools/call' && params && params.name === 'search_catalog') {
    const query = (params.arguments && params.arguments.query) || '';
    console.log('[search] query:', query);

    if (!query.trim()) {
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: "Please tell me what you're looking for." }] } });
    }

    // Determine sort order based on price-intent keywords in the query
    const isExpensive = /expensive|most expensive|priciest|highest price/i.test(query);
    const isCheapest = /cheap|cheapest|lowest price|affordable|budget/i.test(query);
    const sortKey = (isExpensive || isCheapest) ? 'PRICE' : 'RELEVANCE';
    const reverse = isExpensive; // PRICE DESC = most expensive first

    // Strip price adjectives so Shopify searches by product name/type only
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

      // Attach a PRODUCT_IMG token to the tool result text so the widget
      // can render an inline product card in El's chat bubble.
      // Format: [PRODUCT_IMG:imageUrl|title|price]
      // Note: the LLM strips/rewrites tool text, so we ALSO queue a
      // show_product action via pendingActions as a reliable fallback.
      let imgToken = '';
      const topNode = nodes[0];
      if (topNode?.featuredImage?.url) {
        const price = topNode.variants?.nodes?.[0]?.price;
        const priceStr = price ? `$${parseFloat(price.amount).toFixed(2)} ${price.currencyCode}` : '';
        imgToken = ` [PRODUCT_IMG:${topNode.featuredImage.url}|${topNode.title}|${priceStr}]`;
        console.log('🖼️  Image token attached:', topNode.title);

        // Reliable fallback: queue show_product so the widget picks it up
        // via the /api/cart-actions poll even if the token is stripped by the LLM.
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

  // ── MCP: create_cart ───────────────────────────────────────
  // Does NOT add to cart directly — the server has no Shopify session cookie.
  // Instead it:
  //   1. Looks up the variant GID via Storefront GraphQL.
  //   2. Checks inventory and the knownSoldOut set.
  //   3. Queues an { type:'add', variantId, qty } action.
  //   4. The widget drains the queue and calls /cart/add.js in the browser.
  if (method === 'tools/call' && params && params.name === 'create_cart') {
    const productTitle = (params.arguments && params.arguments.product_title) || '';
    const quantity = parseInt((params.arguments && params.arguments.quantity) || 1, 10) || 1;
    const channel = (params.arguments && params.arguments.channel) || 'echo-mart-dev';
    console.log('[cart:add] product="' + productTitle + '" qty=' + quantity + ' channel=' + channel);

    try {
      // Look up the variant ID, available quantity, and whether it's actually for sale
      const searchGql = {
        query: '{ products(first: 1, query: "title:' + productTitle.replace(/"/g, '\\"') + '") { nodes { title handle variants(first: 1) { nodes { id availableForSale quantityAvailable price { amount currencyCode } } } } } }',
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
      const availableForSale = variantNode?.availableForSale;

      console.log('[cart:add] Variant found:', variantGid);
      console.log(`[cart:add] qtyAvailable: ${qtyAvailable}, availableForSale: ${availableForSale}`);

      if (!variantGid) {
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: product.title + ' has no purchasable variant right now.' }] } });
      }

      // Shopify GraphQL returns Global IDs like "gid://shopify/ProductVariant/12345".
      // The AJAX /cart/add.js endpoint requires only the trailing numeric portion.
      const numericVariantId = variantGid.split('/').pop();

      if (availableForSale === false || knownSoldOut.has(String(numericVariantId))) {
        console.log('[cart:add] Not available for sale online (or known sold out)!');
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Sorry, ' + product.title + ' is currently sold out or unavailable online.' }] } });
      }

      // Check how many are ALREADY in the cart
      const state = cartStates.get(channel) || [];
      const existingItem = state.find(item => String(item.variant_id) === numericVariantId);
      const existingQty = existingItem ? existingItem.quantity : 0;
      const totalRequested = quantity + existingQty;

      // ── Inventory Check ────────────────────────────────────────────────
      if (qtyAvailable !== null && qtyAvailable !== undefined) {
        console.log(`[cart:add] Inventory Check -> In stock: ${qtyAvailable}, In cart: ${existingQty}, Adding: ${quantity}, Total: ${totalRequested}`);
        if (qtyAvailable <= 0) {
          console.log('[cart:add] Out of stock!');
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Sorry, ' + product.title + ' is currently out of stock.' }] } });
        }
        if (totalRequested > qtyAvailable) {
          console.log('[cart:add] Insufficient stock. Available:', qtyAvailable, 'Total Requested:', totalRequested);
          if (existingQty > 0) {
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'You already have ' + existingQty + ' in your cart, and we only have ' + qtyAvailable + ' in stock. You can only add ' + Math.max(0, qtyAvailable - existingQty) + ' more.' }] } });
          } else {
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'You asked for ' + quantity + ', but we only have ' + qtyAvailable + ' ' + product.title + ' in stock. Please let me know if you want to add the available amount.' }] } });
          }
        }
      }
      const priceNode = variantNode?.price;
      const unitPrice = priceNode ? ('$' + parseFloat(priceNode.amount).toFixed(2) + ' ' + priceNode.currencyCode) : '';

      // Queue a cart action for the widget to execute via /cart/add.js
      getPending(channel).push({ type: 'add', variantId: numericVariantId, qty: quantity });
      console.log('[cart:add] action queued. variantId=' + numericVariantId + ' qty=' + quantity);

      const text = 'I have signaled the store to add ' + quantity + ' x ' + product.title + ' for you. It should appear in your cart in a moment.';

      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error('[cart:add] error:', JSON.stringify(detail, null, 2));
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'I had trouble adding that to your cart. Please try again.' }] } });
    }
  }

  // ── MCP: get_cart ──────────────────────────────────────────
  // Reads from the in-memory cartStates map that the browser keeps up to date
  // (via POST /api/cart-state) after every cart mutation.
  // This avoids needing a Shopify Admin API call or a server-side session.
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

  // ── MCP: update_cart_item ──────────────────────────────────
  // Re-checks live inventory before queuing the update so El can warn the
  // user if they try to increase beyond available stock.
  if (method === 'tools/call' && params && params.name === 'update_cart_item') {
    const channel = (params.arguments && params.arguments.channel) || 'echo-mart-dev';
    const variantId = (params.arguments && params.arguments.variant_id) || '';
    const newQty = parseInt((params.arguments && params.arguments.quantity) || 1, 10);

    if (!variantId) {
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Please tell me which product to update. Try asking "what is in my cart" first.' }] } });
    }

    console.log('[update_cart_item] Checking inventory for variantId:', variantId);

    // ── Inventory Check for Update ───────────────────────────────────
    try {
      const gql = {
        query: `{
          node(id: "gid://shopify/ProductVariant/${variantId}") {
            ... on ProductVariant {
              availableForSale
              quantityAvailable
              product { title }
            }
          }
        }`,
      };
      const sfRes = await axios.post(
        `https://${SHOPIFY_DOMAIN}/api/2025-04/graphql.json`,
        gql,
        { headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN } }
      );

      const variantNode = sfRes.data?.data?.node;
      if (variantNode) {
        const { availableForSale, quantityAvailable, product } = variantNode;
        console.log(`[update_cart_item] stock: ${quantityAvailable}, forSale: ${availableForSale}`);

        if (availableForSale === false) {
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Sorry, ' + product.title + ' is now sold out.' }] } });
        }
        if (quantityAvailable !== null && quantityAvailable !== undefined && newQty > quantityAvailable) {
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'I can only update that to ' + quantityAvailable + ' because that is all we have in stock.' }] } });
        }
      }
    } catch (err) {
      console.error('[update_cart_item] Inventory check failed (skipping):', err.message);
    }

    // Queue action for widget to execute via /cart/update.js
    getPending(channel).push({ type: 'update', variantId, qty: newQty });
    console.log('[update_cart_item] action queued variantId=' + variantId + ' qty=' + newQty);

    const text = newQty <= 0
      ? 'I have requested to remove that item from your cart.'
      : 'I have signaled the store to update the quantity to ' + newQty + ' for you.';

    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  }

  // ── MCP: remove_from_cart ─────────────────────────────────
  // Reuses the update mechanism: setting quantity to 0 removes the line item
  // via /cart/update.js (Shopify AJAX API convention).
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

    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'I have signaled the store to remove that item for you.' }] } });
  }

  res.status(400).json({
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});

// ─────────────────────────────────────────────────────────────
//  GET /api/cart-actions?channel=...
//  The widget polls this every 1.5 s while El is active.
//  Returns all queued actions and atomically drains the queue so each
//  action is executed exactly once.
// ─────────────────────────────────────────────────────────────
app.get('/api/cart-actions', (req, res) => {
  const channel = (req.query.channel || 'echo-mart-dev').trim();
  const actions = pendingActions.get(channel) || [];
  pendingActions.set(channel, []);   // drain — actions consumed, queue reset
  if (actions.length) console.log(`[cart-actions] channel="${channel}" returning ${actions.length} action(s)`);
  res.json({ actions });
});

// ─────────────────────────────────────────────────────────────
//  POST /api/report-sold-out
//  The browser calls this when Shopify's /cart/add.js rejects an item
//  with a "sold out" error. The variant ID is added to knownSoldOut so
//  El can immediately refuse future add attempts for the same item
//  without needing to re-query Shopify.
// ─────────────────────────────────────────────────────────────
app.post('/api/report-sold-out', (req, res) => {
  const variantId = String(req.body?.variantId || '');
  if (variantId) {
    knownSoldOut.add(variantId);
    console.log(`[sold-out] Variant ${variantId} marked as known sold out.`);
  }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
//  POST /api/cart-state?channel=...
//  The widget calls syncCartState() after every cart mutation,
//  posting the full /cart.js item list here. El's get_cart tool reads
//  from this map instead of making its own Shopify API call, keeping
//  it always in sync with the real browser session cart.
// ─────────────────────────────────────────────────────────────
app.post('/api/cart-state', (req, res) => {
  const channel = (req.query.channel || req.body?.channel || 'echo-mart-dev').trim();
  const items = req.body?.items || [];
  cartStates.set(channel, items);
  console.log(`[cart-state] channel="${channel}" updated: ${items.length} item(s)`);
  res.json({ ok: true });
});
// ─────────────────────────────────────────────────────────────
//  GET /api/product-image?q=<title>
//  Called by the widget when it detects a product name in El's speech
//  (e.g. "I found The Complete Snowboard…") and wants to show an inline
//  product card. Uses the Storefront API for read-only metadata only.
// ─────────────────────────────────────────────────────────────
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