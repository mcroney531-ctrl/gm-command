const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Forwards to the Report Cards /chat endpoint on Render, which runs the
// Claude tool-calling loop. That is now the ONLY thing this function does.
//
// It used to hold a second path: when a caller passed allow_toolless it
// would call api.anthropic.com directly, with the caller's own model and
// max_tokens. That made this a public, unauthenticated Anthropic proxy with
// no rate limit, no budget, no model allowlist and no token ceiling — every
// control that guards the Render endpoint, absent, on a URL anyone can POST
// to. The flag was meant to describe work that needs no live data; it was in
// practice a request to spend the key without supervision. Removed.
//
// The Anthropic key dependency went with it. Nothing here calls Anthropic
// any more, so requiring ANTHROPIC_API_KEY would only have left a dead
// credential able to fail the function before it forwarded anything.
//
// allow_toolless is still accepted and stripped from the forwarded body so
// an older cached client does not break, but it no longer grants anything.
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const reportCardsUrl = (process.env.REPORTCARDS_API_URL || '').replace(/\/$/, '');
  if (!reportCardsUrl) {
    return {
      statusCode: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:
          'REPORTCARDS_API_URL is not configured, so there is no backend to forward to.',
        backend: 'reportcards',
        unreachable: true,
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (err) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  // The frontend never picks the tools — Render owns tool injection.
  const { tools: _tools, allow_toolless: _allowToolless, ...forwardBody } = body;

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
    return {
      statusCode: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:
          'The data backend is unreachable, so this request cannot be answered. Reason: ' +
          (err.message || 'unknown'),
        backend: 'reportcards',
        unreachable: true,
      }),
    };
  }
};
