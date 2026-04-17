/**
 * Unified AI provider — supports OpenAI, Claude (Anthropic), and DeepSeek.
 * All calls go through a single `aiCall()` function.
 * Tokens are tracked to help the user monitor cost.
 */

const AIProvider = (() => {
  let _provider = null;   // 'openai' | 'claude' | 'deepseek'
  let _apiKey = null;
  let _totalTokensUsed = 0;

  // Model defaults — cheapest capable models
  const MODELS = {
    openai:   'gpt-4o-mini',
    claude:   'claude-sonnet-4-20250514',
    deepseek: 'deepseek-chat',
  };

  // Rough cost per 1M tokens (input/output avg) for display
  const COST_PER_M = {
    openai:   0.15,   // gpt-4o-mini
    claude:   3.00,   // claude-sonnet-4-20250514
    deepseek: 0.14,   // deepseek-chat
  };

  const ENDPOINTS = {
    openai:   'https://api.openai.com/v1/chat/completions',
    claude:   'https://api.anthropic.com/v1/messages',
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
  };

  function configure(provider, apiKey) {
    _provider = provider;
    _apiKey = apiKey;
    _totalTokensUsed = 0;
  }

  function getProvider() { return _provider; }
  function getTotalTokens() { return _totalTokensUsed; }
  function getEstimatedCost() {
    return ((_totalTokensUsed / 1_000_000) * (COST_PER_M[_provider] || 0)).toFixed(4);
  }

  // ─── Tool registry ───
  const _tools = {};  // name → { schema, handler }

  /**
   * Register a tool that AI providers can call.
   * @param {string} name - Tool name (e.g. 'web_search')
   * @param {object} schema - JSON Schema for parameters
   * @param {string} description - What the tool does
   * @param {function} handler - async (params) => result string
   */
  function registerTool(name, description, schema, handler) {
    _tools[name] = { description, schema, handler };
  }

  function unregisterTool(name) { delete _tools[name]; }
  function getRegisteredTools() { return Object.keys(_tools); }

  /** Build OpenAI-compatible tools array from registry. */
  function _buildToolDefs() {
    return Object.entries(_tools).map(([name, t]) => ({
      type: 'function',
      function: { name, description: t.description, parameters: t.schema },
    }));
  }

  /** Build Claude-compatible tools array from registry. */
  function _buildClaudeToolDefs() {
    return Object.entries(_tools).map(([name, t]) => ({
      name,
      description: t.description,
      input_schema: t.schema,
    }));
  }

  /**
   * Main API call. Returns { text, tokensUsed }.
   * @param {string} systemPrompt
   * @param {string} userMessage
   * @param {object} opts - { temperature, maxTokens, json, useTools }
   */
  async function aiCall(systemPrompt, userMessage, opts = {}) {
    const { temperature = 0.3, maxTokens = 1024, json = false, useTools = false, forceFirstTool = null } = opts;

    if (_provider === 'claude') {
      return _callClaude(systemPrompt, userMessage, temperature, maxTokens, json, useTools, forceFirstTool);
    } else {
      // OpenAI-compatible (works for both openai and deepseek)
      return _callOpenAI(systemPrompt, userMessage, temperature, maxTokens, json, useTools, forceFirstTool);
    }
  }

  async function _callOpenAI(systemPrompt, userMessage, temperature, maxTokens, json, useTools, forceFirstTool) {
    const endpoint = ENDPOINTS[_provider];
    const model = MODELS[_provider];
    const toolDefs = useTools && Object.keys(_tools).length ? _buildToolDefs() : null;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    // Tool call loop — AI may call tools multiple times
    const MAX_ROUNDS = 15;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const body = { model, messages, temperature, max_tokens: maxTokens };
      if (json && !toolDefs) body.response_format = { type: 'json_object' };
      if (toolDefs) {
        body.tools = toolDefs;
        // Force the model to call a specific tool on the first round
        if (round === 0 && forceFirstTool) {
          body.tool_choice = { type: 'function', function: { name: forceFirstTool } };
        }
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`API error (${res.status}): ${err}`);
      }

      const data = await res.json();
      const tokensUsed = data.usage?.total_tokens || 0;
      _totalTokensUsed += tokensUsed;

      const choice = data.choices?.[0];
      const msg = choice?.message;

      // If no tool calls, we're done
      if (choice?.finish_reason !== 'tool_calls' || !msg?.tool_calls?.length) {
        return { text: msg?.content || '', tokensUsed };
      }

      // Execute each tool call and append results
      messages.push(msg); // assistant message with tool_calls
      for (const tc of msg.tool_calls) {
        const tool = _tools[tc.function.name];
        let result;
        if (tool) {
          try {
            const args = JSON.parse(tc.function.arguments || '{}');
            result = await tool.handler(args);
          } catch (e) {
            result = `Tool error: ${e.message}`;
          }
        } else {
          result = `Unknown tool: ${tc.function.name}`;
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }

    throw new Error('Tool call loop exceeded maximum rounds');
  }

  async function _callClaude(systemPrompt, userMessage, temperature, maxTokens, json, useTools, forceFirstTool) {
    const toolDefs = useTools && Object.keys(_tools).length ? _buildClaudeToolDefs() : null;
    const messages = [{ role: 'user', content: userMessage }];

    const MAX_ROUNDS = 15;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const body = {
        model: MODELS.claude,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        temperature,
      };
      if (toolDefs) {
        body.tools = toolDefs;
        if (round === 0 && forceFirstTool) {
          body.tool_choice = { type: 'tool', name: forceFirstTool };
        }
      }

      const res = await fetch(ENDPOINTS.claude, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': _apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`API error (${res.status}): ${err}`);
      }

      const data = await res.json();
      const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
      _totalTokensUsed += tokensUsed;

      // Check for tool use blocks
      const toolUseBlocks = (data.content || []).filter(b => b.type === 'tool_use');
      const textBlocks = (data.content || []).filter(b => b.type === 'text');
      const text = textBlocks.map(b => b.text).join('');

      if (data.stop_reason !== 'tool_use' || !toolUseBlocks.length) {
        return { text, tokensUsed };
      }

      // Execute tool calls and continue
      messages.push({ role: 'assistant', content: data.content });
      const toolResults = [];
      for (const block of toolUseBlocks) {
        const tool = _tools[block.name];
        let result;
        if (tool) {
          try {
            result = await tool.handler(block.input || {});
          } catch (e) {
            result = `Tool error: ${e.message}`;
          }
        } else {
          result = `Unknown tool: ${block.name}`;
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    throw new Error('Tool call loop exceeded maximum rounds');
  }

  /**
   * Multi-message conversation call (for chat).
   * @param {string} systemPrompt
   * @param {Array} messages - [{role, content}, ...]
   * @param {object} opts
   */
  async function aiChat(systemPrompt, messages, opts = {}) {
    const { temperature = 0.4, maxTokens = 1024 } = opts;

    if (_provider === 'claude') {
      const body = {
        model: MODELS.claude,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature,
      };

      const res = await fetch(ENDPOINTS.claude, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': _apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`API error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      const text = data.content?.[0]?.text || '';
      const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
      _totalTokensUsed += tokensUsed;
      return { text, tokensUsed };
    } else {
      const body = {
        model: MODELS[_provider],
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        temperature,
        max_tokens: maxTokens,
      };

      const res = await fetch(ENDPOINTS[_provider], {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`API error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      const tokensUsed = data.usage?.total_tokens || 0;
      _totalTokensUsed += tokensUsed;
      return { text, tokensUsed };
    }
  }

  /**
   * Quick validation — makes a tiny call to verify the key works.
   */
  async function validateKey() {
    try {
      const { text } = await aiCall('You are a test.', 'Say "ok"', { maxTokens: 8 });
      return text.length > 0;
    } catch (e) {
      console.error('Key validation failed:', e);
      return false;
    }
  }

  return { configure, getProvider, getTotalTokens, getEstimatedCost, aiCall, aiChat, validateKey, COST_PER_M, registerTool, unregisterTool, getRegisteredTools };
})();
