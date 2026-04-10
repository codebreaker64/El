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

// 1. Enable CORS for all origins
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

  console.log(`\n🟢  /api/start-el  channel="${channel}"  remoteUid="${remoteUid}"`);

  // ── Agora v2.5 Join payload ───────────────────────────────
  // Mirrors your curl exactly. pipeline_id pulls the saved agent config
  // Mirrors your curl exactly.
  const agoraPayload = {
    name: `El_Assistant_${Date.now()}`,  // must be unique per-call
    pipeline_id: AGORA_PIPELINE_ID,     // ← holds your Deepgram/OpenAI/MiniMax credentials

    properties: {
      channel,
      token: AGORA_RTC_TOKEN,
      agent_rtc_uid: '715636',
      remote_rtc_uids: [remoteUid],
      enable_string_uid: false,
      idle_timeout: 120,

      asr: {
        vendor: 'deepgram',
        params: {
          url: 'wss://api.deepgram.com/v1/listen',
          model: 'nova-3',
          keyterm: '',
          language: 'en',
        },
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
            '- CART: When a user says "buy" or "add to cart," use the \'create_cart\' tool and tell them: "I\'ve added that to your cart. You can see the link on your screen now."',
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
          allowed_tools: ['search_catalog'],
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

      parameters: {
        silence_config: {
          action: 'think',
          content: 'politely ask if the user is still online',
          timeout_ms: 10000,
        },
      },

      turn_detection: null,   // use Agora Studio default

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
    res.json(response.data);

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌  Agora error:', JSON.stringify(detail, null, 2));
    res.status(500).json({ error: 'Failed to start El', detail });
  }
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
        tools: [{
          name: 'search_catalog',
          description: 'Search for products in the EchoMart Shopify store by keyword.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Product search keyword, e.g. "blue sneakers"' },
            },
            required: ['query'],
          },
        }],
      },
    });
  }

  // ── MCP: tool invocation ───────────────────────────────────
  if (method === 'tools/call' && params?.name === 'search_catalog') {
    const query = params?.arguments?.query || '';
    console.log(`\n🔍  El is searching for: "${query}"`);

    if (!query.trim()) {
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: "Please tell me what you're looking for." }] },
      });
    }

    const graphqlQuery = {
      query: `{
        search(query: "${query.replace(/"/g, '\\"')}", first: 3, types: PRODUCT) {
          nodes {
            ... on Product {
              title
              variants(first: 1) {
                nodes { price { amount currencyCode } }
              }
            }
          }
        }
      }`,
    };

    try {
      const shopifyRes = await axios.post(
        `https://${SHOPIFY_DOMAIN}/api/2025-04/graphql.json`,
        graphqlQuery,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN,
          },
        }
      );

      const nodes = shopifyRes.data?.data?.search?.nodes || [];
      const products = nodes
        .filter(p => p.title)
        .map(p => {
          const price = p.variants?.nodes?.[0]?.price;
          const priceStr = price ? `$${parseFloat(price.amount).toFixed(2)} ${price.currencyCode}` : 'price unavailable';
          return `${p.title} at ${priceStr}`;
        });

      const text = products.length
        ? `Found ${products.length} product${products.length > 1 ? 's' : ''}: ${products.join('; ')}.`
        : "No matching products found. Try a different search term.";

      console.log('✅  Shopify result:', text);
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text }] },
      });

    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error('❌  Shopify error:', JSON.stringify(detail, null, 2));
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'I had trouble searching the store. Please try again.' }] },
      });
    }
  }

  // ── Unknown MCP method ─────────────────────────────────────
  res.status(400).json({
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
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