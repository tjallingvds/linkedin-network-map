/**
 * AI JSON — robust extraction, repair, and validation of JSON from AI responses.
 *
 * Replaces greedy regex (/{[\s\S]*}/) with balanced-brace extraction that
 * correctly handles nested objects, multiple JSON blocks, and markdown fencing.
 */

const AIJSON = (() => {
  // ─── Schemas ───────────────────────────────────────────────

  const SCHEMAS = {
    classifyIntent: {
      required: { action: 'string' },
      defaults: { action: 'network', person: null, query: null, type: null, count: null, question: null, company: null, title: null },
    },
    decomposeQuery: {
      required: {},
      defaults: { roles: [], industries: [], keywords: [], intent: '', searchStrategy: 'broad', requireEmail: false, requirePhone: false },
    },
    normalSearch: {
      required: { action: 'string' },
      defaults: { action: 'message', summary: '', people: [], suggest_web_search: false, message: '', suggestions: [] },
    },
    parseBrief: {
      required: {},
      defaults: { firms: [], titles: [], excludeFirms: [], excludeTitles: [], excludeSeniority: [], geography: [], context: '' },
    },
    enrichProfile: {
      required: {},
      defaults: {
        previousRoles: [], education: [], skills: [], bio: '',
        notableAchievements: [], location: '', linkedinHeadline: '',
        linkedinUrl: '', interests: [], talkingPoints: [], sources: [],
      },
    },
    tablePlan: {
      required: {},
      defaults: { columns: [], intent: '' },
    },
  };

  // ─── Balanced-brace extraction ─────────────────────────────

  /**
   * Find the first balanced JSON object or array in text.
   * Tracks brace/bracket depth and skips string contents.
   * Returns the substring or null.
   */
  function _extractBalanced(text, openChar, closeChar) {
    const start = text.indexOf(openChar);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }

      if (ch === '"' && !escape) {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === openChar) depth++;
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }

    return null; // unbalanced
  }

  // ─── Repair attempts ──────────────────────────────────────

  function _tryParse(str) {
    try { return JSON.parse(str); }
    catch { return undefined; }
  }

  function _repair(str) {
    // Attempt 1: as-is
    let result = _tryParse(str);
    if (result !== undefined) return result;

    // Attempt 2: strip markdown fences
    let cleaned = str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    result = _tryParse(cleaned);
    if (result !== undefined) return result;

    // Attempt 3: remove trailing commas before } or ]
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    result = _tryParse(cleaned);
    if (result !== undefined) return result;

    // Attempt 4: remove control characters (except newline/tab)
    cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    result = _tryParse(cleaned);
    if (result !== undefined) return result;

    // Attempt 5: fix single-quoted keys/values → double quotes (simple heuristic)
    cleaned = cleaned.replace(/'/g, '"');
    result = _tryParse(cleaned);
    if (result !== undefined) return result;

    return undefined; // all repairs failed
  }

  // ─── Schema validation ────────────────────────────────────

  function _validate(data, schema) {
    if (!schema) return data;

    // Check required fields
    for (const [field, type] of Object.entries(schema.required || {})) {
      if (data[field] === undefined || data[field] === null) {
        return null; // required field missing
      }
      if (type === 'string' && typeof data[field] !== 'string') return null;
      if (type === 'array' && !Array.isArray(data[field])) return null;
    }

    // Apply defaults for missing optional fields
    const defaults = schema.defaults || {};
    for (const [field, defaultVal] of Object.entries(defaults)) {
      if (data[field] === undefined || data[field] === null) {
        data[field] = Array.isArray(defaultVal) ? [] : defaultVal;
      }
      // Type coercion: if default is array but got non-array, wrap it
      if (Array.isArray(defaultVal) && !Array.isArray(data[field])) {
        data[field] = data[field] ? [data[field]] : [];
      }
    }

    return data;
  }

  // ─── Public API ───────────────────────────────────────────

  /**
   * Extract and validate a JSON object from AI response text.
   * @param {string} text - Raw AI response
   * @param {string} [schemaName] - Schema name from SCHEMAS
   * @returns {{ ok: boolean, data?: object, error?: string, raw?: string }}
   */
  function extractObject(text, schemaName) {
    if (!text) return { ok: false, error: 'empty input' };

    const raw = _extractBalanced(text, '{', '}');
    if (!raw) return { ok: false, error: 'no JSON object found' };

    const parsed = _repair(raw);
    if (parsed === undefined) return { ok: false, error: 'parse failed', raw };

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'not an object', raw };
    }

    const schema = schemaName ? SCHEMAS[schemaName] : null;
    if (schema) {
      const validated = _validate(parsed, schema);
      if (!validated) return { ok: false, error: 'validation failed', raw };
      return { ok: true, data: validated };
    }

    return { ok: true, data: parsed };
  }

  /**
   * Extract a JSON array from AI response text.
   * @param {string} text - Raw AI response
   * @returns {{ ok: boolean, data?: array, error?: string, raw?: string }}
   */
  function extractArray(text) {
    if (!text) return { ok: false, error: 'empty input' };

    const raw = _extractBalanced(text, '[', ']');
    if (!raw) return { ok: false, error: 'no JSON array found' };

    const parsed = _repair(raw);
    if (parsed === undefined) return { ok: false, error: 'parse failed', raw };

    if (!Array.isArray(parsed)) return { ok: false, error: 'not an array', raw };

    return { ok: true, data: parsed };
  }

  return { extractObject, extractArray, SCHEMAS };
})();
