// Netlify Scheduled Function — pings the Report Cards API every 5 minutes
// (see netlify.toml) to keep the Render free-tier dyno warm, so the first
// chat message after a period of inactivity doesn't hit a 30s cold start
// against Netlify's 10s function timeout.
//
// Always returns 200: a failed health ping is not a function failure, and
// a non-2xx here would make Netlify treat the scheduled invocation itself
// as broken.
// The URL is defaulted rather than required: this used to skip silently
// whenever REPORTCARDS_API_URL was unset, so the one job it exists to do
// could be switched off by an env var nobody remembered to set, with no
// visible symptom beyond chat "feeling slow" on the first message.
const DEFAULT_API_URL = 'https://ddreportcards.onrender.com';

exports.handler = async function () {
  const apiUrl = ((process.env.REPORTCARDS_API_URL || DEFAULT_API_URL)).replace(/\/$/, '');
  try {
    const resp = await fetch(`${apiUrl}/health`);
    return { statusCode: 200, body: JSON.stringify({ status: 'pinged', apiStatus: resp.status }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ status: 'ping-failed', error: err.message }) };
  }
};
