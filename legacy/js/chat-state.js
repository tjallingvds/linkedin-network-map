/**
 * ChatState — centralized state store for the chat module.
 *
 * Owns all mutable state: messages, discovery results, batch results,
 * parsed brief, loaded data, and network stats.
 * All localStorage persistence happens here — no other module writes chat state.
 */

const ChatState = (() => {
  // ─── State ─────────────────────────────────────────────────
  let _messages = _loadMessages();
  let _networkStats = '';
  let _allData = [];
  let _lastDiscoveryResults = _loadDiscoveryResults();
  let _lastBatchResults = null;
  let _lastQuery = null;
  let _lastNetworkResults = null;
  let _lastEnrichment = null; // { person, profile, text }
  let _currentTable = null; // { headers, rows, filename, source: 'paste'|'upload' }
  let _currentBrief = null;
  let _parsedBrief = null;

  // ─── Messages ──────────────────────────────────────────────

  function _saveMessages() {
    try {
      const toSave = _messages.slice(-50);
      localStorage.setItem('chat_messages', JSON.stringify(toSave));
    } catch (e) { console.warn('Failed to save chat messages:', e); }
  }

  function _loadMessages() {
    try {
      const saved = localStorage.getItem('chat_messages');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  }

  function pushMessage(role, content) {
    _messages.push({ role, content });
    _saveMessages();
  }

  function getMessages() { return _messages; }

  function clearHistory() {
    _messages = [];
    _saveMessages();
    _lastDiscoveryResults = null;
    _saveDiscoveryResults();
  }

  function restoreMessages(msgs) { _messages = msgs; }

  // ─── Discovery results ─────────────────────────────────────

  function _saveDiscoveryResults() {
    try {
      if (_lastDiscoveryResults) {
        const toSave = {
          people: _lastDiscoveryResults.people?.slice(0, 100) || [],
          query: _lastDiscoveryResults.query || '',
        };
        localStorage.setItem('discovery_results', JSON.stringify(toSave));
      } else {
        localStorage.removeItem('discovery_results');
      }
    } catch { /* ignore */ }
  }

  function _loadDiscoveryResults() {
    try {
      const saved = localStorage.getItem('discovery_results');
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  }

  function getLastDiscovery() { return _lastDiscoveryResults; }
  function setLastDiscovery(d) {
    _lastDiscoveryResults = d;
    _saveDiscoveryResults();
  }

  function getLastBatchResults() { return _lastBatchResults; }
  function setLastBatchResults(r) { _lastBatchResults = r; }

  function getLastQuery() { return _lastQuery; }
  function setLastQuery(q) { _lastQuery = q; }

  function getLastNetworkResults() { return _lastNetworkResults; }
  function setLastNetworkResults(r) { _lastNetworkResults = r; }

  function getLastEnrichment() { return _lastEnrichment; }
  function setLastEnrichment(e) { _lastEnrichment = e; }

  function getCurrentTable() { return _currentTable; }
  function setCurrentTable(t) { _currentTable = t; }
  function clearCurrentTable() { _currentTable = null; }

  // ─── Brief ─────────────────────────────────────────────────

  function getCurrentBrief() { return _currentBrief; }
  function setCurrentBrief(b) { _currentBrief = b; }

  function getParsedBrief() { return _parsedBrief; }
  function setParsedBrief(b) { _parsedBrief = b; }

  // ─── Network data ──────────────────────────────────────────

  function getAllData() { return _allData; }
  function setAllData(data) { _allData = data; }

  function getNetworkStats() { return _networkStats; }

  function buildNetworkSummary(data) {
    _allData = data;
    const cats = {};
    const companies = {};
    const industries = {};

    data.forEach(p => {
      cats[p._cat] = (cats[p._cat] || 0) + 1;
      if (p.c) companies[p.c] = (companies[p.c] || 0) + 1;
      if (p._industry) industries[p._industry] = (industries[p._industry] || 0) + 1;
    });

    const topCompanies = Object.entries(companies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, count]) => `${name}(${count})`)
      .join(', ');

    const topIndustries = Object.entries(industries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => `${name}(${count})`)
      .join(', ');

    const catSummary = Object.entries(cats)
      .map(([key, count]) => `${Categorizer.CATEGORIES[key]?.label || key}: ${count}`)
      .join(', ');

    _networkStats = `NETWORK: ${data.length} connections
CATEGORIES: ${catSummary}
TOP COMPANIES: ${topCompanies}
INDUSTRIES: ${topIndustries}`;

    return _networkStats;
  }

  return {
    pushMessage, getMessages, clearHistory, restoreMessages,
    getLastDiscovery, setLastDiscovery,
    getLastBatchResults, setLastBatchResults,
    getLastQuery, setLastQuery,
    getLastNetworkResults, setLastNetworkResults,
    getLastEnrichment, setLastEnrichment,
    getCurrentTable, setCurrentTable, clearCurrentTable,
    getCurrentBrief, setCurrentBrief,
    getParsedBrief, setParsedBrief,
    getAllData, setAllData,
    getNetworkStats, buildNetworkSummary,
  };
})();
