const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

// Server-to-server fetch proxy for external pages/feeds the browser can't
// reach directly due to CORS (Rotowire/ESPN/PFT/CBS/PFF RSS, Rotowire
// player pages for scouting). Replaces a third-party public CORS proxy
// (api.allorigins.win) that every news feed depended on — a single point
// of failure that took down the News tray, chat news context, and
// scouting news together whenever it was slow or rate-limited.
//
// Returns { status, contents } — same shape the client already expected
// from allorigins' /get endpoint, so callers only needed to change the URL.

function isBlockedHost(hostname) {
  const h = (hostname || '').toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local, incl. cloud metadata endpoints
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 unique local
  return false;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { ...CORS_HEADERS, 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }

  const targetUrl = event.queryStringParameters && event.queryStringParameters.url;
  if (!targetUrl) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing url parameter' }) };
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (err) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid url parameter' }) };
  }
  if (parsed.protocol !== 'https:' || isBlockedHost(parsed.hostname)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'URL not allowed' }) };
  }

  try {
    const resp = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GMCommandBot/1.0; +https://gm-command.netlify.app)' },
      signal: AbortSignal.timeout(9000),
    });
    const contents = await resp.text();
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
      body: JSON.stringify({ status: resp.status, contents }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
