const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Thin proxy to the Report Cards FastAPI server's /chat endpoint, which runs
// the actual Claude tool-calling loop server-side on Render.
//
// Why this moved off Netlify: a tool-calling conversation can chain 3-5
// round trips (each a full Claude API call), which reliably blew past
// Netlify's 10s free-tier function ceiling on anything needing more than a
// tool call or two. Render has no such ceiling, and tool execution there is
// a direct in-process function call instead of an HTTP round-trip back out
// to this same proxy — both the timeout and the extra latency are gone.
//
// If REPORTCARDS_API_URL isn't set, this degrades gracefully to a plain,
// tool-less Claude call straight from here — same fallback behavior as
// before.
exports.handler = async function (event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const reportCardsUrl = (process.env.REPORTCARDS_API_URL || '').replace(/\/$/, '');

  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
    };
  }

  try {
    const body = JSON.parse(event.body);

    if (reportCardsUrl) {
      // Strip whatever the frontend sent for `tools` — the Render endpoint
      // controls tool injection now, same as this function used to.
      const { tools: _tools, ...forwardBody } = body;

      const resp = await fetch(`${reportCardsUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forwardBody),
      });
      const data = await resp.json();
      return {
        statusCode: resp.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    }

    // Graceful degradation: no Report Cards backend configured — plain
    // Claude call, no tools, no roster/news context.
    const { tools: _tools, ...rest } = body;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(rest),
    });
    const data = await resp.json();
    return {
      statusCode: resp.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
