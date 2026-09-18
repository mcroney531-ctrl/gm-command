// Server-to-server fetch proxy for the news feeds the browser can't reach
// directly because they send no CORS headers. Returns { status, contents } —
// the shape callers have always expected.
//
// This was a DENYLIST: any https URL was fetched unless its hostname string
// looked like a private address. Two problems with that, one obvious and one
// not:
//
//   1. It was an open proxy. Anyone who found the URL could route arbitrary
//      traffic through this function, on this site's bandwidth and IP, with
//      abuse attributed here.
//   2. The private-address checks tested the hostname TEXT, never the address
//      it resolves to. Literal IPv4 was handled — new URL() normalises
//      https://2130706433/ and https://0x7f000001/ to 127.0.0.1 before the
//      regexes run, so those were caught. What passed was any NAME that
//      resolves to a private address: metadata.google.internal, or a public
//      DNS name pointed at 127.0.0.1 such as localtest.me. Cloud metadata was
//      reachable through a filter written specifically to block it. Both IPv6
//      loopback spellings passed too — hostname keeps the brackets, so the
//      h === '::1' test never fired, and [::ffff:127.0.0.1] normalises to
//      [::ffff:7f00:1], which matched nothing.
//
// An allowlist closes both by construction. The proxy exists for a fixed set
// of feeds; anything else is not a use case, so there is no bypass to
// enumerate and no resolver behaviour to reason about. The denylist is gone
// rather than kept as defence in depth, because keeping it would suggest the
// host check is doing work it is not.
//
// Redirects are followed but re-checked: an allowlisted host that 302s
// somewhere else would otherwise walk straight back out of the allowlist.

const DEFAULT_ALLOWED_HOSTS = [
  'www.rotowire.com',
  'www.espn.com',
  'profootballtalk.nbcsports.com',
  'www.cbssports.com',
  'www.pff.com',
];

// Env override so a feed can be added without a deploy. It can only ever
// REPLACE the list, never widen it to everything — an empty or malformed
// value falls back to the built-in hosts rather than allowing all.
const configuredHosts = (process.env.FETCH_PROXY_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_HOSTS = new Set(
  configuredHosts.length ? configuredHosts : DEFAULT_ALLOWED_HOSTS
);

// The app's own pages. Same-origin requests send no Origin header at all,
// which is the normal case here, so absence is allowed and a foreign origin
// is not.
const ALLOWED_ORIGINS = [
  'https://gm-command.netlify.app',
  'http://localhost:8888',
];
const ALLOWED_ORIGIN_REGEX = /^https:\/\/[a-z0-9-]+--gm-command\.netlify\.app$/;

// RSS feeds run tens to low hundreds of KB. A cap keeps a hostile or broken
// response from being read entirely into memory and then JSON-encoded.
const MAX_BYTES = 3 * 1024 * 1024;

function corsHeaders(origin) {
  const headers = { 'Vary': 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function originAllowed(origin) {
  if (!origin) return true; // same-origin request
  return ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGIN_REGEX.test(origin);
}

function fail(statusCode, origin, error) {
  return {
    statusCode,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    body: JSON.stringify({ error }),
  };
}

// Read at most MAX_BYTES, so the cap holds even without a Content-Length.
async function readCapped(resp) {
  const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
  if (!reader) return (await resp.text()).slice(0, MAX_BYTES);
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      out += decoder.decode(value.slice(0, value.length - (total - MAX_BYTES)), { stream: false });
      try { await reader.cancel(); } catch (e) { /* already closed */ }
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

exports.handler = async function (event) {
  const origin = event.headers && (event.headers.origin || event.headers.Origin);

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: originAllowed(origin) ? 204 : 403,
      headers: {
        ...corsHeaders(origin),
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'GET') {
    return fail(405, origin, 'Method not allowed');
  }
  if (!originAllowed(origin)) {
    return fail(403, origin, `Origin ${origin} is not allowed to use this proxy.`);
  }

  const targetUrl = event.queryStringParameters && event.queryStringParameters.url;
  if (!targetUrl) return fail(400, origin, 'Missing url parameter');

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (err) {
    return fail(400, origin, 'Invalid url parameter');
  }
  if (parsed.protocol !== 'https:') {
    return fail(400, origin, 'Only https URLs are proxied');
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return fail(
      403,
      origin,
      `Host ${parsed.hostname} is not proxied. This endpoint serves a fixed set of news feeds.`
    );
  }

  try {
    const resp = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GMCommandBot/1.0; +https://gm-command.netlify.app)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(9000),
    });

    // A 302 out of an allowlisted host would otherwise land anywhere.
    try {
      const finalHost = new URL(resp.url || parsed.toString()).hostname.toLowerCase();
      if (!ALLOWED_HOSTS.has(finalHost)) {
        return fail(502, origin, `Feed redirected to ${finalHost}, which is not proxied.`);
      }
    } catch (e) {
      return fail(502, origin, 'Could not verify the final URL after redirects');
    }

    const contents = await readCapped(resp);
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120',
      },
      body: JSON.stringify({ status: resp.status, contents }),
    };
  } catch (err) {
    return fail(502, origin, err.message);
  }
};
