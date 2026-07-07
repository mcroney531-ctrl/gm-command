const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Tool definitions backed by the always-on Report Cards FastAPI server.
// REPORTCARDS_API_URL must be set in Netlify environment variables.
// Tools are only injected when the env var is present — GM Command
// degrades gracefully to plain Claude without them.
const TOOLS = [
  {
    name: 'get_player_value',
    description:
      'Look up dynasty and redraft fantasy value for a player by name. ' +
      'Returns FantasyCalc dynasty value, position rank, redraft value, and 30-day trend. ' +
      'Use for any question about what a player is worth in dynasty.',
    input_schema: {
      type: 'object',
      properties: {
        player_name: {
          type: 'string',
          description: "Player's full or partial name (e.g. 'Ja\'Marr Chase', 'Josh Allen', 'Pollard')",
        },
      },
      required: ['player_name'],
    },
  },
  {
    name: 'get_roster',
    description:
      'Get the full skill-position roster for a dynasty team owner, with FantasyCalc dynasty ' +
      'values attached to each player. Sorted by dynasty value. Use to answer questions about ' +
      'roster composition, depth by position, or overall asset value.',
    input_schema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: "Sleeper display name of the roster owner (e.g. 'TitansTrev55')",
        },
      },
      required: ['owner'],
    },
  },
  {
    name: 'get_trending_players',
    description:
      'Get current trending add activity on Sleeper — players being picked up most in ' +
      'the last 24 hours. Skill-position players only (QB/RB/WR/TE). ' +
      'Use for waiver wire and speculative add questions.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Number of trending players to return (1-100, default 25)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_league_info',
    description:
      'Get the canonical league settings for Dynasty Daddies: scoring format, roster slots, ' +
      'number of teams, PPR setting, superflex configuration, dynasty rules.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

async function executeTool(name, input, apiBase) {
  switch (name) {
    case 'get_player_value': {
      const q = encodeURIComponent(input.player_name || '');
      const resp = await fetch(`${apiBase}/players/search?q=${q}`);
      if (!resp.ok) return { error: `Player search failed (HTTP ${resp.status})` };
      return resp.json();
    }
    case 'get_roster': {
      const owner = encodeURIComponent(input.owner || '');
      const resp = await fetch(`${apiBase}/roster/${owner}`);
      if (!resp.ok) return { error: `Roster fetch failed (HTTP ${resp.status})` };
      return resp.json();
    }
    case 'get_trending_players': {
      const limit = Math.min(100, Math.max(1, input.limit || 25));
      const resp = await fetch(`${apiBase}/players/trending?limit=${limit}`);
      if (!resp.ok) return { error: `Trending fetch failed (HTTP ${resp.status})` };
      return resp.json();
    }
    case 'get_league_info': {
      const resp = await fetch(`${apiBase}/league`);
      if (!resp.ok) return { error: `League info fetch failed (HTTP ${resp.status})` };
      return resp.json();
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

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

    // Strip any tools the frontend may have sent; we control tool injection.
    const { messages: incomingMessages, tools: _tools, ...rest } = body;
    const messages = [...(incomingMessages || [])];
    const tools = reportCardsUrl ? TOOLS : undefined;

    let finalResponse = null;

    // Tool-calling loop — continue until Claude returns a text response.
    // Safety cap of 5 rounds prevents runaway loops.
    for (let round = 0; round < 5; round++) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          ...rest,
          messages,
          ...(tools ? { tools } : {}),
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        return {
          statusCode: resp.status,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        };
      }

      // No tool calls — this is the final answer.
      if (data.stop_reason !== 'tool_use') {
        finalResponse = data;
        break;
      }

      // Execute all tool_use blocks in this turn concurrently.
      const toolUseBlocks = data.content.filter((b) => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const result = await executeTool(block.name, block.input, reportCardsUrl);
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          };
        })
      );

      // Append the assistant turn + tool results, then loop.
      messages.push({ role: 'assistant', content: data.content });
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalResponse) {
      finalResponse = {
        error: 'Tool-calling loop reached maximum rounds without a final text response.',
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(finalResponse),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
