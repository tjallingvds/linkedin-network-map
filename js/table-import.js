/**
 * TableImport — parse TSV (Excel paste) or CSV into a normalized table.
 *
 * Output shape: { headers: string[], rows: string[][], filename?: string }
 */

const TableImport = (() => {

  /**
   * Detect whether a pasted string looks like a TSV/CSV table.
   * Heuristic: at least 2 lines AND a consistent delimiter on the first 2 lines.
   */
  function looksLikeTable(text) {
    if (!text || typeof text !== 'string') return false;
    const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
    if (lines.length < 2) return false;
    const tabs0 = (lines[0].match(/\t/g) || []).length;
    const tabs1 = (lines[1].match(/\t/g) || []).length;
    if (tabs0 >= 1 && tabs0 === tabs1) return true;
    const commas0 = (lines[0].match(/,/g) || []).length;
    const commas1 = (lines[1].match(/,/g) || []).length;
    if (commas0 >= 1 && commas0 === commas1) return true;
    return false;
  }

  /**
   * Parse a string as TSV or CSV. Auto-detects delimiter.
   */
  function parse(text, opts = {}) {
    if (!text) return { headers: [], rows: [] };
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Detect delimiter — prefer tab if present in the first non-empty line
    const firstLine = normalized.split('\n').find(l => l.length > 0) || '';
    const delim = firstLine.includes('\t') ? '\t' : ',';

    const rows = _parseDelimited(normalized, delim);
    if (!rows.length) return { headers: [], rows: [] };

    const headers = rows[0].map(h => h.trim());
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell && cell.trim().length > 0));

    return {
      headers,
      rows: dataRows,
      filename: opts.filename || null,
      delimiter: delim === '\t' ? 'tsv' : 'csv',
    };
  }

  /**
   * RFC 4180-ish delimited parser. Handles quoted fields with embedded delimiters and newlines.
   */
  function _parseDelimited(text, delim) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') { cell += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { cell += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === delim) { row.push(cell); cell = ''; }
        else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else { cell += ch; }
      }
    }

    // Flush last cell/row
    if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
    return rows;
  }

  /**
   * Serialize rows back to TSV (best for clipboard → Excel paste).
   */
  function toTsv(headers, rows) {
    const escape = (s) => {
      const v = s == null ? '' : String(s);
      // Tabs and newlines inside cells need to be quoted/escaped for safe paste
      if (/[\t\n"]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
      return v;
    };
    const lines = [headers.map(escape).join('\t')];
    for (const r of rows) lines.push(r.map(escape).join('\t'));
    return lines.join('\n');
  }

  /**
   * Serialize rows back to CSV.
   */
  function toCsv(headers, rows) {
    const escape = (s) => {
      const v = s == null ? '' : String(s);
      if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
      return v;
    };
    const lines = [headers.map(escape).join(',')];
    for (const r of rows) lines.push(r.map(escape).join(','));
    return lines.join('\n');
  }

  return { looksLikeTable, parse, toTsv, toCsv };
})();
