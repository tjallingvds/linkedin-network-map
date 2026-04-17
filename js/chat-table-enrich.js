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
    const systemPrompt = `You translate a user's request into a list of column operations on a spreadsheet of people.

CURRENT COLUMNS: ${JSON.stringify(headers)}
SAMPLE ROW: ${JSON.stringify(sampleRow)}

Output a JSON object:
{
  "operations": [
    {
      "mode": "fill" | "add",
      "name": "exact column name",
      "description": "what to find for each person, in 1 short sentence"
    }
  ],
  "intent": "one-line summary"
}

Rules:
- Use mode "fill" when the column ALREADY EXISTS in CURRENT COLUMNS (case-insensitive). Use the EXACT existing column name, not a renamed version. Fill mode will only enrich rows where this cell is empty.
- Use mode "add" only when no matching column exists.
- Common phrases that map to fill operations: "find emails for people missing them", "fill in phones", "add LinkedIns to ones that don't have them", "complete the data" → all use "fill" if the column already exists.
- Prefer short, spreadsheet-friendly column names ("Email", "Phone", "LinkedIn", "Title", "Company", "Location").
- The "description" tells the per-row research step exactly what to look for.
- If the user asks for multiple things, output one operation per thing.
- If the user's request is too vague to map to operations, output an empty operations array and explain in "intent".
- Return ONLY the JSON object.`;

    try {
      const { text } = await AIProvider.aiCall(systemPrompt, userRequest, {
        temperature: 0.1,
        maxTokens: 400,
        json: AIProvider.getProvider() !== 'claude',
      });
      const result = AIJSON.extractObject(text, 'tablePlan');
      if (!result.ok) return { operations: [], intent: '' };
      // Normalize: support both new "operations" and legacy "columns" output from the model
      const ops = Array.isArray(result.data.operations)
        ? result.data.operations
        : (Array.isArray(result.data.columns) ? result.data.columns.map(c => ({ mode: 'add', ...c })) : []);
      return { operations: ops, intent: result.data.intent || '' };
    } catch (e) {
      console.warn('Column planning failed:', e);
    }
    return { operations: [], intent: '' };
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
   * `fields` = [{ name, description }], returns array of strings same length.
   */
  async function _enrichRow(person, fields) {
    if (!Enricher.isConfigured()) return fields.map(() => '');

    const idLine = `${person.name}${person.company ? ' at ' + person.company : ''}${person.title ? ' (' + person.title + ')' : ''}`;
    const colList = fields.map((c, i) => `${i + 1}. ${c.name} — ${c.description}`).join('\n');

    const systemPrompt = `You research one specific person using web_search and extract requested data points.

PERSON: ${idLine}
KNOWN INFO: ${person.raw}

DATA POINTS TO FIND (in order):
${colList}

Process:
1. CALL web_search 1-3 times with focused queries that include the person's name AND company. Good queries: "Julien Trouillet Macquarie email", "Daniele Magazzeni UBS LinkedIn".
2. Read the results carefully and extract the requested data points.
3. Return ONLY a JSON array of strings — exactly ${fields.length} elements, one per data point in order. Use empty string "" if a value can't be found. Be terse — just the value.

Example return for [Email, Phone, LinkedIn]: ["jane@acme.com", "", "linkedin.com/in/janedoe"]`;

    try {
      const { text } = await AIProvider.aiCall(systemPrompt, `Find these for ${person.name}: ${fields.map(c => c.name).join(', ')}`, {
        temperature: 0.1,
        maxTokens: 600,
        useTools: true,
        forceFirstTool: 'web_search',
      });
      const result = AIJSON.extractArray(text);
      if (result.ok && Array.isArray(result.data)) {
        const out = [];
        for (let i = 0; i < fields.length; i++) {
          const v = result.data[i];
          out.push(v == null ? '' : String(v));
        }
        return out;
      }
    } catch (e) {
      console.warn(`Row enrichment failed for ${person.name}:`, e);
    }
    return fields.map(() => '');
  }

  /**
   * Main entry: enrich a table based on a user request.
   * Returns { headers, rows, addedColumns, filledColumns, intent }.
   */
  async function enrichTable(table, userRequest) {
    const { headers, rows } = table;
    if (!rows.length) return { headers, rows, addedColumns: [], filledColumns: [], intent: 'Empty table.' };

    // Plan: figure out which columns to fill or add
    const plan = await _planColumns(userRequest, headers, rows[0]);
    if (!plan.operations.length) {
      return { headers, rows, addedColumns: [], filledColumns: [], intent: plan.intent || 'No operations to run.' };
    }

    // Resolve each op into either a fill (existing column index) or add (new column)
    const lowerHeaders = headers.map(h => h.toLowerCase());
    const fillOps = []; // { name, description, colIdx }
    const addOps = [];  // { name, description }
    const seenNew = new Set();

    for (const op of plan.operations) {
      const matchIdx = lowerHeaders.indexOf((op.name || '').toLowerCase());
      if (op.mode === 'fill' && matchIdx !== -1) {
        fillOps.push({ name: headers[matchIdx], description: op.description || op.name, colIdx: matchIdx });
      } else if (matchIdx !== -1) {
        // Even if the model said "add" but the column exists, treat as fill
        fillOps.push({ name: headers[matchIdx], description: op.description || op.name, colIdx: matchIdx });
      } else if (!seenNew.has(op.name.toLowerCase())) {
        addOps.push({ name: op.name, description: op.description || op.name });
        seenNew.add(op.name.toLowerCase());
      }
    }

    if (!fillOps.length && !addOps.length) {
      return { headers, rows, addedColumns: [], filledColumns: [], intent: 'No work to do.' };
    }

    // Combined field list passed to per-row research (fills first, then adds)
    const allFields = [...fillOps, ...addOps];
    const totalRows = rows.length;
    if (_onProgress) _onProgress('start', 0, totalRows, allFields);

    const newHeaders = [...headers, ...addOps.map(c => c.name)];
    // Deep-copy rows + pad with empty strings for new columns
    const enrichedRows = rows.map(r => {
      const padded = [...r];
      while (padded.length < headers.length) padded.push('');
      for (let k = 0; k < addOps.length; k++) padded.push('');
      return padded;
    });

    // Enrich rows with limited concurrency
    const CONCURRENCY = 4;
    let cursor = 0;
    let done = 0;

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= totalRows) return;
        const row = enrichedRows[i];
        const person = _identifyPerson(headers, row);

        // Per-row, only research fields that need it:
        //   - fill ops where the cell is currently empty
        //   - all add ops (new columns are empty everywhere)
        const fieldsToResearch = [];
        const fieldTargets = []; // parallel array: { type: 'fill', colIdx } or { type: 'add', addOffset }
        fillOps.forEach(op => {
          const cell = (row[op.colIdx] || '').trim();
          if (!cell) {
            fieldsToResearch.push({ name: op.name, description: op.description });
            fieldTargets.push({ type: 'fill', colIdx: op.colIdx });
          }
        });
        addOps.forEach((op, k) => {
          fieldsToResearch.push({ name: op.name, description: op.description });
          fieldTargets.push({ type: 'add', addOffset: k });
        });

        if (fieldsToResearch.length && person.name) {
          const values = await _enrichRow(person, fieldsToResearch);
          for (let v = 0; v < fieldsToResearch.length; v++) {
            const tgt = fieldTargets[v];
            const val = values[v] || '';
            if (!val) continue;
            if (tgt.type === 'fill') {
              row[tgt.colIdx] = val;
            } else {
              row[headers.length + tgt.addOffset] = val;
            }
          }
        }

        done++;
        if (_onProgress) _onProgress('progress', done, totalRows, allFields);
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, totalRows); w++) workers.push(worker());
    await Promise.all(workers);

    if (_onProgress) _onProgress('done', done, totalRows, allFields);

    const summary = [];
    if (addOps.length) summary.push(`Added: ${addOps.map(c => c.name).join(', ')}`);
    if (fillOps.length) summary.push(`Filled missing: ${fillOps.map(c => c.name).join(', ')}`);

    return {
      headers: newHeaders,
      rows: enrichedRows,
      addedColumns: addOps,
      filledColumns: fillOps,
      intent: plan.intent || summary.join(' · ') || 'Done.',
    };
  }

  return { enrichTable, setProgressCallback };
})();
