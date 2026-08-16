// Netlify Scheduled Function — pings the Report Cards API every 5 minutes
// (see netlify.toml) to keep the Render free-tier dyno warm, so the first
// chat message after a period of inactivity doesn't hit a 30s cold start
// against Netlify's 10s function timeout.
//
// Always returns 200: a failed health ping is not a function failure, and
// a non-2xx here would make Netlify treat the scheduled invocation itself
// as broken.
exports.handler = async function () {
  const apiUrl = (process.env.REPORTCARDS_API_URL || '').replace(/\/$/, '');
  if (!apiUrl) {
    return { statusCode: 200, body: JSON.stringify({ status: 'skipped', reason: 'REPORTCARDS_API_URL not set' }) };
  }
  try {
    const resp = await fetch(`${apiUrl}/health`);
    return { statusCode: 200, body: JSON.stringify({ status: 'pinged', apiStatus: resp.status }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ status: 'ping-failed', error: err.message }) };
  }
};
