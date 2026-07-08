// Fires a background ping to the Render API to wake it from cold start.
// Called by the frontend on page load — returns immediately (200) so the
// browser doesn't block, while Render warms up in the background.
exports.handler = async function () {
  const apiUrl = (process.env.REPORTCARDS_API_URL || '').replace(/\/$/, '');
  if (apiUrl) {
    // Fire-and-forget — we don't await, so this function returns instantly.
    fetch(`${apiUrl}/health`).catch(() => {});
  }
  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ status: 'pinging' }),
  };
};
