const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Fallback path for the Report Cards FastAPI /chat endpoint, which runs the
// real Claude tool-calling loop server-side on Render.
//
// Why the loop lives on Render: a tool-calling conversation chains 3-5 full
// Claude API calls, which reliably blew past Netlify's 10s free-tier
// function ceiling. Render has no such ceiling, and tool execution there is
// an in-process call rather than an HTTP round-trip back out to this proxy.
// The browser therefore calls Render directly; this function only exists
// for callers that cannot reach onrender.com.
//
// This function will NOT answer a data question without tools. It used to:
// when REPORTCARDS_API_URL was unset it "degraded gracefully" to a plain
// Claude call with no roster, no player values, no depth charts, and none
// of the sourcing rules that live in the Render system prompt. The reply
// came back in the same bubble, in the same confident voice, with no
// outward sign that every fact in it came from training data — which is
// the exact failure this whole effort has been closing off. Degrading
// silently from "sourced" to "sounds sourced" is not graceful.
//
// A caller that genuinely needs no live data — rewriting a scouting note
// the user typed, synthesizing a tendencies blurb from their own intel —
// says so with allow_toolless: true. Everything else gets an honest 503.
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

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (err) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  // The frontend never picks the tools — Render owns tool injection.
  const { tools: _tools, allow_toolless: allowToolless, ...forwardBody } = body;

  if (reportCardsUrl) {
    try {
      const resp = await fetch(`${reportCardsUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forwardBody),
        signal: AbortSignal.timeout(9000),
      });
      const data = await resp.json();
      return {
        statusCode: resp.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    } catch (err) {
      // Reaching Render failed outright. Fall through: a request that
      // allows a tool-less answer can still be served, anything else gets
      // the 503 below with the real reason attached.
      if (!allowToolless) {
        return {
          statusCode: 503,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error:
              'The data backend is unreachable, so this question cannot be ' +
              'answered from live rosters, values, or depth charts. Rather ' +
              'than answer it from memory, it is being refused. Reason: ' +
              (err.message || 'unknown'),
            backend: 'reportcards',
            unreachable: true,
          }),
        };
      }
    }
  } else if (!allowToolless) {
    return {
      statusCode: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:
          'REPORTCARDS_API_URL is not configured, so there is no tool-enabled ' +
          'backend to answer this. Refusing rather than answering from memory.',
        backend: 'reportcards',
        unreachable: true,
      }),
    };
  }

  // Explicitly tool-less work only: transforming text the user supplied,
  // where there is no external fact to get wrong.
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(forwardBody),
    });
    const data = await resp.json();
    return {
      statusCode: resp.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
