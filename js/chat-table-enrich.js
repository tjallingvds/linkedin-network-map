/**
 * ChatTableEnrich — orchestrate per-row enrichment of an uploaded/pasted table.
 *
 * Flow:
 * 1. Look at the user request + table headers, ask AI which new columns to add
 * 2. For each row, fire focused web searches for the missing fields
 * 3. AI extracts the requested values from search results
 * 4. Build an enriched table (same rows + new columns)
 */

const ChatTableEnrich = (() => {
  let _onProgress = null;
  function setProgressCallback(fn) { _onProgress = fn; }

  /**
   * Plan: ask AI to translate a free-form user request into a list of column specs.
   * Each col spec = { name, description, fillFromExistingHeader? }
   * Examples:
   *   "find emails for everyone" → [{ name: "Email", description: "professional email address" }]
   *   "add LinkedIn URLs and verify their current title" → [
   *     { name: "LinkedIn", description: "linkedin.com/in/ profile URL" },
   *     { name: "Verified Title", description: "their actual current job title (verify)" }
   *   ]
   */
  async function _planColumns(userRequest, headers, sampleRow) {
    const systemPrompt = `You translate a user's request into a list of NEW columns to add to a spreadsheet of people.

CURRENT COLUMNS: ${JSON.stringify(headers)}
SAMPLE ROW: ${JSON.stringify(sampleRow)}

Output a JSON object: { "columns": [{ "name": "Column Name", "description": "what to find for each person, in 1 short sentence" }], "intent": "one-line summary" }

Rules:
- Only add NEW columns — do not duplicate existing column names.
- Pick short, spreadsheet-friendly column names ("Email", "Phone", "LinkedIn", "Current Title", "Current Company", "Years at Company", "Location", etc).
- The "description" tells the per-row research step exactly what to look for.
- If the user asks for multiple things, output one column per thing.
- If the user's request is too vague to map to columns, output an empty columns array and explain in "intent".
- Return ONLY the JSON object.`;

    try {
      const { text } = await AIProvider.aiCall(systemPrompt, userRequest, {
        temperature: 0.1,
        maxTokens: 400,
        json: AIProvider.getProvider() !== 'claude',
      });
      const result = AIJSON.extractObject(text, 'tablePlan');
      if (result.ok && Array.isArray(result.data.columns)) return result.data;
    } catch (e) {
      console.warn('Column planning failed:', e);
    }
    return { columns: [], intent: '' };
  }

  /**
   * Build a person identity hint from a row using its headers.
   * Picks out name, company, title, email, linkedin if any header looks like that.
   */
  function _identifyPerson(headers, row) {
    const get = (re) => {
      const i = headers.findIndex(h => re.test(h.toLowerCase()));
      return i === -1 ? '' : (row[i] || '').trim();
    };
    const fullName = get(/^(name|full ?name|person|contact)$/i)
      || [get(/first ?name/i), get(/last ?name/i)].filter(Boolean).join(' ').trim();
    return {
      name: fullName,
      company: get(/^(company|employer|firm|organi[sz]ation)$/i),
      title: get(/^(title|role|position|job ?title)$/i),
      email: get(/^(email|e-?mail)$/i),
      linkedin: get(/(linkedin|li ?url)/i),
      raw: headers.map((h, i) => `${h}: ${row[i] || ''}`).join(' | '),
    };
  }

  /**
   * Per-row enrichment: run focused Tavily searches and extract requested fields.
   */
  async function _enrichRow(person, columns) {
    if (!Enricher.isConfigured()) {
      // No web search available — return empty values for all new columns
      return columns.map(() => '');
    }

    const idLine = `${person.name}${person.company ? ' at ' + person.company : ''}${person.title ? ' (' + person.title + ')' : ''}`;
    const colList = columns.map((c, i) => `${i + 1}. ${c.name} — ${c.description}`).join('\n');

    const systemPrompt = `You research one specific person and extract requested data points using web_search.

PERSON: ${idLine}
KNOWN INFO: ${person.raw}

DATA POINTS TO FIND (in order):
${colList}

Use the web_search tool to find this information. Search efficiently — 1 to 3 searches max. Prefer LinkedIn, company sites, news, and professional profiles.

Return ONLY a JSON array of strings — exactly ${columns.length} elements, one per data point in order. Use an empty string "" if a value can't be found. Be terse — just the value, no extra prose.

Example return for [Email, Phone, LinkedIn]: ["jane@acme.com", "", "linkedin.com/in/janedoe"]`;

    try {
      const { text } = await AIProvider.aiCall(systemPrompt, `Find: ${columns.map(c => c.name).join(', ')}`, {
        temperature: 0.1,
        maxTokens: 600,
        useTools: true,
      });
      const result = AIJSON.extractArray(text);
      if (result.ok && Array.isArray(result.data)) {
        // Pad/trim to exact length
        const out = [];
        for (let i = 0; i < columns.length; i++) {
          const v = result.data[i];
          out.push(v == null ? '' : String(v));
        }
        return out;
      }
    } catch (e) {
      console.warn(`Row enrichment failed for ${person.name}:`, e);
    }
    return columns.map(() => '');
  }

  /**
   * Main entry: enrich a table based on a user request.
   * Returns { headers, rows, addedColumns, intent }.
   */
  async function enrichTable(table, userRequest) {
    const { headers, rows } = table;
    if (!rows.length) return { headers, rows, addedColumns: [], intent: 'Empty table.' };

    // Plan: figure out which columns to add
    const plan = await _planColumns(userRequest, headers, rows[0]);
    if (!plan.columns.length) {
      return { headers, rows, addedColumns: [], intent: plan.intent || 'No columns to add.' };
    }

    // Avoid duplicate column names
    const headerSet = new Set(headers.map(h => h.toLowerCase()));
    const newColumns = plan.columns.filter(c => !headerSet.has(c.name.toLowerCase()));
    if (!newColumns.length) {
      return { headers, rows, addedColumns: [], intent: 'All requested columns already exist.' };
    }

    if (_onProgress) _onProgress('start', 0, rows.length, newColumns);

    // Enrich rows with limited concurrency
    const CONCURRENCY = 4;
    const enrichedRows = new Array(rows.length);
    let cursor = 0;
    let done = 0;

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= rows.length) return;
        const person = _identifyPerson(headers, rows[i]);
        const newValues = person.name
          ? await _enrichRow(person, newColumns)
          : newColumns.map(() => '');
        enrichedRows[i] = [...rows[i], ...newValues];
        done++;
        if (_onProgress) _onProgress('progress', done, rows.length, newColumns);
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, rows.length); w++) workers.push(worker());
    await Promise.all(workers);

    if (_onProgress) _onProgress('done', done, rows.length, newColumns);

    return {
      headers: [...headers, ...newColumns.map(c => c.name)],
      rows: enrichedRows,
      addedColumns: newColumns,
      intent: plan.intent || `Added ${newColumns.map(c => c.name).join(', ')}.`,
    };
  }

  return { enrichTable, setProgressCallback };
})();
