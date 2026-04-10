// ============================================================
//  El – EchoMart Voice Shopping Assistant
//  All-in-One Prototype Server
//  Usage:  node server.js
//          ngrok http 3000
// ============================================================

require('dotenv').config();        // loads .env.local automatically
const express = require('express');
const cors    = require('cors');    // <--- Add this
const axios   = require('axios');

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
const AGORA_APP_ID   = process.env.AGORA_APP_ID;        // 43255fc9405c4e4dbeae512d2700d917
const AGORA_TOKEN    = process.env.AGORA_TOKEN;          // agora token=007eJx...
const AGORA_RTC_TOKEN = process.env.AGORA_RTC_TOKEN;    // RTC token for the channel
const AGORA_PIPELINE_ID = process.env.AGORA_PIPELINE_ID; // 1ff64a4474604469874405f1d681160e
const NGROK_URL      = process.env.NGROK_URL;            // https://xxxx.ngrok-free.app

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;       // your-store.myshopify.com
const SHOPIFY_TOKEN  = process.env.SHOPIFY_STOREFRONT_TOKEN; // shpat_xxxx

// ── Startup guard ────────────────────────────────────────────
const REQUIRED_VARS = [
  'AGORA_APP_ID', 'AGORA_TOKEN', 'AGORA_RTC_TOKEN',
  'AGORA_PIPELINE_ID', 'NGROK_URL', 'SHOPIFY_DOMAIN', 'SHOPIFY_STOREFRONT_TOKEN',
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
  const channel   = req.body?.channel   || 'echo-mart-dev';
  const remoteUid = req.body?.uid       || '123';   // must match uid in Liquid code

  console.log(`\n🟢  /api/start-el  channel="${channel}"  remoteUid="${remoteUid}"`);

  // ── Agora v2.5 Join payload ───────────────────────────────
  // Mirrors your curl exactly. pipeline_id pulls the saved agent config
  // from Agora Studio; properties here override only the dynamic fields.
  const agoraPayload = {
    name: `El_Assistant_${Date.now()}`,  // must be unique per-call
    pipeline_id: AGORA_PIPELINE_ID,

    properties: {
      channel,
      token:            AGORA_RTC_TOKEN,
      agent_rtc_uid:    '715636',
      remote_rtc_uids:  [remoteUid],
      enable_string_uid: false,
      idle_timeout:     120,

      asr: {
        vendor: 'deepgram',
        params: {
          url:      'wss://api.deepgram.com/v1/listen',
          model:    'nova-3',
          keyterm:  '',
          language: 'en',
        },
      },

      llm: {
        url:    'https://api.openai.com/v1/chat/completions',
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
      },

      tts: {
        vendor: 'minimax',
        params: {
          url:   'wss://api-uw.minimax.io/ws/v1/t2a_v2',
          model: 'speech-2.8-turbo',
          voice_setting: {
            voice_id: 'English_radiant_girl',
          },
        },
      },

      sal: {
        sal_mode:    'locking',
        sample_urls: {},
      },

      parameters: {
        silence_config: {
          action:     'think',
          content:    'politely ask if the user is still online',
          timeout_ms: 10000,
        },
      },

      turn_detection: null,   // use Agora Studio default

      advanced_features: {
        enable_rtm: true,
        enable_sal: true,
      },
    },
  };

  try {
    const response = await axios.post(
      `https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}/join`,
      agoraPayload,
      {
        headers: {
          // Auth style from your curl: "agora token=007eJx..."
          Authorization:  `agora token=${AGORA_TOKEN}`,
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
//  ENDPOINT 2: /api/shopify-search
//  El calls this via MCP whenever it needs to search products.
//  Agora sends: { arguments: { query: "blue running shoes" } }
// ============================================================
app.post('/api/shopify-search', async (req, res) => {
  const query = req.body?.arguments?.query || '';
  console.log(`\n🔍  El is searching for: "${query}"`);

  if (!query.trim()) {
    return res.json({ result: 'Please tell me what you\'re looking for.' });
  }

  const graphqlQuery = {
    query: `{
      search(query: "${query.replace(/"/g, '\\"')}", first: 3, types: PRODUCT) {
        nodes {
          ... on Product {
            title
            variants(first: 1) {
              nodes {
                price { amount currencyCode }
              }
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
          'Content-Type':                    'application/json',
          'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN,
        },
      }
    );

    const nodes    = shopifyRes.data?.data?.search?.nodes || [];
    const products = nodes
      .filter(p => p.title)
      .map(p => {
        const price    = p.variants?.nodes?.[0]?.price;
        const priceStr = price ? `$${parseFloat(price.amount).toFixed(2)} ${price.currencyCode}` : 'price unavailable';
        return `${p.title} at ${priceStr}`;
      });

    const result = products.length
      ? `I found ${products.length} product${products.length > 1 ? 's' : ''}: ${products.join('; ')}.`
      : "I couldn't find any matching products. Try a different search term.";

    console.log('✅  Shopify result:', result);
    res.json({ result });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌  Shopify error:', JSON.stringify(detail, null, 2));
    res.json({ result: 'I had trouble searching the store right now. Please try again.' });
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
