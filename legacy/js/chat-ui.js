/**
 * Chat UI — full-page chat view (no popup).
 * Renders into #chatPage which is shown via the view toggle.
 */

const ChatUI = (() => {
  let _data = [];
  let _initialized = false;
  let _classifying = false;

  function init(data) {
    _data = data;
    Chat.buildNetworkSummary(data);
    if (_initialized) return;
    _initialized = true;
    _bindInputEvents();
    _bindClassifyBtn();
    _bindNewChatBtn();
    _updateClassifyBtn();
    _renderAIStatus();

    // Restore the last active chat session or show welcome
    if (_activeChatId) {
      _switchToChat(_activeChatId);
    } else {
      // Check if there's a recent unfinished chat
      const lastChat = _chatHistory[_chatHistory.length - 1];
      if (lastChat && !lastChat.done) {
        _switchToChat(lastChat.id);
      } else {
        _renderWelcome();
      }
    }
    _renderChatHistory();

    // Wire up progress callbacks
    Chat.setEnrichProgressCallback((status, done, total, query) => {
      _updateEnrichProgress(status, done, total, query);
    });
    Chat.setDiscoveryProgressCallback((status, done, total, query) => {
      _updateDiscoveryProgress(status, done, total, query);
    });

    // Wire up per-search progress from Tavily tool calls
    Enricher.setSearchProgressCallback((count, query) => {
      _updateSearchTick(count, query);
    });

    // Table enrichment progress
    if (typeof ChatTableEnrich !== 'undefined') {
      ChatTableEnrich.setProgressCallback((stage, done, total, columns) => {
        _showTableEnrichProgress(stage, done, total, columns);
      });
    }
  }

  // ─── Welcome Message ───
  function _renderWelcome() {
    const container = document.getElementById('chatPageMessages');
    const hasAI = !!AIProvider.getProvider();
    const otherCount = _data.filter(p => p._cat === 'other').length;
    const stats = Categorizer.getStats(_data);

    const providerNames = { openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };
    const provider = AIProvider.getProvider();
    const hasSearch = Enricher.isConfigured();

    const welcome = document.createElement('div');
    welcome.className = 'chat-page-welcome';
    welcome.innerHTML = `
      <img src="img/logo.svg" alt="" class="welcome-logo">
      <h3>Discover people</h3>
      <p>Surface non-obvious insights from your ${_data.length.toLocaleString()} connections.</p>
    `;
    container.appendChild(welcome);
  }

  // ─── Input Events ───
  function _bindInputEvents() {
    const input = document.getElementById('chatPageInput');
    const sendBtn = document.getElementById('chatPageSend');
    const attachBtn = document.getElementById('chatPageAttach');
    const fileInput = document.getElementById('chatPageFileInput');

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      // Show/hide send button based on content
      sendBtn.classList.toggle('visible', input.value.trim().length > 0);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Detect paste of TSV/CSV → import as a table instead of plain text
    input.addEventListener('paste', (e) => {
      const pasted = e.clipboardData?.getData('text/plain');
      if (!pasted) return;
      if (TableImport.looksLikeTable(pasted)) {
        e.preventDefault();
        const table = TableImport.parse(pasted);
        if (table.headers.length && table.rows.length) {
          _importTable({ ...table, source: 'paste' });
        }
      }
    });

    // Attach button → open file picker
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const table = TableImport.parse(text, { filename: file.name });
          if (table.headers.length && table.rows.length) {
            _importTable({ ...table, source: 'upload', filename: file.name });
          } else {
            _addMessage('system', 'Could not parse table from that file.');
          }
        } catch (err) {
          _addMessage('system', `Failed to read file: ${err.message}`);
        }
        fileInput.value = ''; // allow re-uploading same file
      });
    }

    sendBtn.addEventListener('click', () => handleSend());
    _updateToolbarChips();
  }

  /**
   * Import a parsed table into chat state and render a preview card.
   */
  function _importTable(table) {
    ChatState.setCurrentTable(table);
    // Remove welcome screen if present
    const welcome = document.querySelector('.chat-page-welcome');
    if (welcome) welcome.remove();
    _addTableCard(table, { isImport: true });
    // Update placeholder to hint table mode
    const input = document.getElementById('chatPageInput');
    if (input) input.placeholder = 'Ask what to add to the table — e.g. "find emails for everyone"';
  }

  function _updateToolbarChips() {
    const aiChip = document.getElementById('toolbarAiChip');
    const searchChip = document.getElementById('toolbarSearchChip');
    if (!aiChip || !searchChip) return;

    const provider = AIProvider.getProvider();
    if (provider) {
      const names = { openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };
      // Sparkle icon for AI provider
      aiChip.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2L13.09 8.26L18 6L14.74 10.91L21 12L14.74 13.09L18 18L13.09 15.74L12 22L10.91 15.74L6 18L9.26 13.09L3 12L9.26 10.91L6 6L10.91 8.26L12 2Z"/></svg>${names[provider] || provider}`;
      aiChip.classList.add('active');
    } else {
      aiChip.classList.remove('active');
    }

    if (Enricher.isConfigured()) {
      searchChip.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Web`;
      searchChip.classList.add('active');
    } else {
      searchChip.classList.remove('active');
    }
  }

  // ─── Classify Button ───
  function _bindClassifyBtn() {
    document.getElementById('classifyBtn')?.addEventListener('click', async () => {
      if (_classifying) return;

      if (!AIProvider.getProvider()) {
        Modal.showSettings();
        return;
      }

      const otherCount = _data.filter(p => p._cat === 'other').length;
      if (otherCount === 0) return;

      _classifying = true;
      const btn = document.getElementById('classifyBtn');
      const label = document.getElementById('classifyBtnLabel');
      btn.classList.add('working');
      label.textContent = 'Classifying...';

      try {
        const changed = await Categorizer.aiCategorizeAll(_data, (done, total) => {
          label.textContent = `${done}/${total}`;
          updateClassificationStatus(done, total);
          // Live-update graph & chips on each batch
          if (typeof renderCategoryChips === 'function') renderCategoryChips();
          if (typeof applyFilters === 'function') applyFilters();
          if (typeof buildGraph === 'function' && activeView === 'graph') buildGraph();
        });

        if (changed > 0) {
          label.textContent = `${changed} reclassified`;
        } else {
          const stillOther = _data.filter(p => p._cat === 'other').length;
          label.textContent = stillOther > 0 ? `${stillOther} remain "Other"` : 'All classified';
        }
        btn.classList.remove('working');

        // Final re-render
        if (typeof renderCategoryChips === 'function') renderCategoryChips();
        if (typeof applyFilters === 'function') applyFilters();
        if (typeof buildGraph === 'function') buildGraph();
        if (typeof renderFullList === 'function' && activeView === 'list') renderFullList();
        refreshData(_data);
      } catch (e) {
        label.textContent = 'Error — try again';
        btn.classList.remove('working');
        console.error('Classification error:', e);
      }

      _classifying = false;
      setTimeout(() => _updateClassifyBtn(), 2000);
    });
  }

  function _updateClassifyBtn() {
    const btn = document.getElementById('classifyBtn');
    const label = document.getElementById('classifyBtnLabel');
    if (!btn || !label) return;

    const otherCount = _data.filter(p => p._cat === 'other').length;
    const hasAI = !!AIProvider.getProvider();

    if (otherCount === 0) {
      label.textContent = 'All classified ✓';
      btn.disabled = true;
      btn.classList.remove('working');
    } else if (!hasAI) {
      label.textContent = `Classify ${otherCount} "Other"`;
      btn.disabled = false;
    } else {
      label.textContent = `Classify ${otherCount} "Other"`;
      btn.disabled = false;
    }
  }

  // ─── AI Status Pill (removed — was annoying) ───
  function _renderAIStatus() { _updateToolbarChips(); }
  function _updateAIStatus() {}

  function updateClassificationStatus(done, total) {
    const pill = document.getElementById('aiStatus');
    if (!pill) return;
    pill.innerHTML = `
      <span class="ai-status-dot working"></span>
      <span>Classifying ${done}/${total}...</span>
    `;
  }

  function finishClassification() {
    _updateAIStatus();
    _updateClassifyBtn();
  }

  // ─── Send Message ───
  async function handleSend() {
    const input = document.getElementById('chatPageInput');
    const msg = input.value.trim();
    if (!msg) return;

    input.value = '';
    input.style.height = 'auto';
    input.placeholder = 'Follow up or start a new search...';
    document.getElementById('chatPageSend')?.classList.remove('visible');

    // Remove welcome screen on first message
    const welcome = document.querySelector('.chat-page-welcome');
    if (welcome) welcome.remove();

    _addMessage('user', msg);
    _addToChatHistory(msg);

    if (AIProvider.getProvider()) {
      _showTyping(true);
      const result = await Chat.send(msg);
      _showTyping(false);
      _hideEnrichProgress();
      _hideResearching();

      // ─── Deterministic rendering from structured results ───
      if (result.tableEnriched) {
        // Enriched table — render as a copy/download-able table card
        if (result.intent) _addMessage('assistant', _esc(result.intent), false);
        const didWork = (result.addedColumns?.length || 0) + (result.filledColumns?.length || 0);
        if (didWork) {
          _addTableCard(result, {
            isResult: true,
            addedColumns: result.addedColumns,
            filledColumns: result.filledColumns,
            filledCounts: result.filledCounts,
          });
        } else {
          _addMessage('system', 'No changes. Try a more specific request like "find emails" or "add LinkedIn URLs".');
        }
      } else if (result.structured) {
        // Structured JSON response from network search
        _renderStructuredResult(result, msg);
      } else if (result.discovered && result.people?.length > 0) {
        // Web discovery results — summary + cards
        _addMessage('assistant', result.text.split('\n')[0], false);
        _addDiscoveryResults(result.people, result.query);
      } else if (result.enriched && result.profile && result.person) {
        // Markdown already contains all the structured info — no duplicate profile card
        _addMessage('assistant', _formatMarkdown(result.text), true);
      } else if (result.batchEnriched && result.results?.length > 0) {
        _addMessage('assistant', _formatMarkdown(result.text), true);
        _addBatchEnrichCards(result.results, result.query);
      } else {
        // Plain text fallback (clarification, followup, errors)
        _addMessage('assistant', _formatMarkdown(result.text), true);
      }

      _updateTokenCounter();
      if (_activeChatId) _saveChatSession(_activeChatId);
    } else {
      // Local search
      const results = Chat.localSearch(msg);
      if (results.length > 0) {
        _addPersonCards(results);
      } else {
        _addMessage('system', 'No matching people found. Try broader terms or connect AI for smarter search.');
      }
    }
  }

  /**
   * Render a structured result from the network search AI.
   * No regex, no text reformatting — deterministic from JSON.
   */
  function _renderStructuredResult(result, originalMsg) {
    const container = document.getElementById('chatPageMessages');

    if (result.action === 'message') {
      _addMessage('assistant', result.message || result.text, false);
      return;
    }

    if (result.action === 'suggest_scope') {
      // AI suggests refining the search — show suggestions as clickable options
      _addMessage('assistant', result.message || result.text, false);
      if (result.suggestions?.length > 0) {
        _addScopeSuggestions(result.suggestions, originalMsg);
      }
      return;
    }

    // Show summary
    if (result.text) {
      _addMessage('assistant', result.text, false);
    }

    // Render people as cards
    if (result.people?.length > 0) {
      const cardPeople = result.people.map(p => {
        const np = p._networkPerson;
        return {
          name: p.name,
          title: p.title || '',
          company: p.company || '',
          context: p.relevance || '',
          linkedin: np?.u || '',
          source: '',
          inNetwork: np || false,
          _networkPerson: np,
          email: np?.e || p.email || '',
          phone: np?.ph || p.phone || '',
        };
      });
      _addDiscoveryResults(cardPeople, originalMsg);
    }

    // Show web search form if suggested — deterministic, not regex
    if (result.suggestWebSearch && Enricher.isConfigured()) {
      const webQuery = result._webQuery || originalMsg;
      const form = document.createElement('div');
      form.className = 'chat-web-search-form';
      form.innerHTML = `
        <div class="chat-wsf-label">Search the web for more results?</div>
        <div class="chat-wsf-row">
          <input type="number" class="chat-wsf-count" value="25" min="5" max="200" step="5" placeholder="# people">
          <button class="chat-wsf-go">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            Find people online
          </button>
        </div>
      `;
      form.querySelector('.chat-wsf-go').addEventListener('click', () => {
        const count = parseInt(form.querySelector('.chat-wsf-count').value) || 25;
        form.querySelector('.chat-wsf-go').disabled = true;
        form.querySelector('.chat-wsf-go').textContent = 'Searching...';
        form.querySelector('.chat-wsf-count').disabled = true;
        _triggerWebDiscovery(webQuery, count);
      });
      container.appendChild(form);
      container.scrollTop = container.scrollHeight;
    }
  }

  /**
   * Show clickable scope suggestions from the AI.
   */
  function _addScopeSuggestions(suggestions, originalMsg) {
    const container = document.getElementById('chatPageMessages');
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-scope-suggestions';

    suggestions.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'chat-scope-btn';
      btn.textContent = s;
      btn.addEventListener('click', () => {
        // Disable all suggestion buttons
        wrapper.querySelectorAll('.chat-scope-btn').forEach(b => {
          b.disabled = true;
          b.classList.add('used');
        });
        btn.classList.add('selected');
        // Send the suggestion as a new message
        const input = document.getElementById('chatPageInput');
        input.value = s;
        handleSend();
      });
      wrapper.appendChild(btn);
    });

    // Also add a "Search all" button if there are multiple suggestions
    if (suggestions.length > 1) {
      const allBtn = document.createElement('button');
      allBtn.className = 'chat-scope-btn chat-scope-all';
      allBtn.textContent = 'Search for all of these';
      allBtn.addEventListener('click', () => {
        wrapper.querySelectorAll('.chat-scope-btn').forEach(b => {
          b.disabled = true;
          b.classList.add('used');
        });
        allBtn.classList.add('selected');
        const combined = suggestions.join('. ');
        const input = document.getElementById('chatPageInput');
        input.value = combined;
        handleSend();
      });
      wrapper.appendChild(allBtn);
    }

    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  /**
   * Trigger web discovery directly — bypasses classifier and AI extraction.
   * Takes the raw user query and an explicit count.
   */
  async function _triggerWebDiscovery(query, count) {
    _showTyping(true);
    const result = await Chat.discover(query, count);
    _showTyping(false);
    _hideEnrichProgress();

    if (result.discovered && result.people?.length > 0) {
      // Summary line + cards only
      _addMessage('assistant', result.text.split('\n')[0], false);
      _addDiscoveryResults(result.people, result.query);
    } else {
      _addMessage('assistant', result.text || 'No results found.', false);
    }
    _updateTokenCounter();
    if (_activeChatId) _saveChatSession(_activeChatId);
  }

  function sendSuggestion(text) {
    const input = document.getElementById('chatPageInput');
    input.value = text;
    handleSend();
  }

  /**
   * Restore saved messages from a previous session into the chat UI.
   */
  function _restoreSavedMessages(messages, hasDiscovery = false) {
    // Remove welcome screen
    const welcome = document.querySelector('.chat-page-welcome');
    if (welcome) welcome.remove();

    // Track the last user message for context in structured results
    let lastUserMsg = '';

    for (const msg of messages) {
      if (msg.role === 'user') {
        lastUserMsg = msg.content;
        _addMessage('user', msg.content);
      } else if (msg.role === 'assistant') {
        let content = msg.content;

        // Try to parse as structured JSON result (network search, no_matches, etc.)
        const parsed = _tryParseStructured(content);
        if (parsed && parsed.action) {
          // Re-render as proper cards/UI instead of raw JSON
          const matchedPeople = (parsed.people || []).map(p => {
            const np = _data.find(d => `${d.f} ${d.l}`.toLowerCase() === (p.name || '').toLowerCase());
            return { ...p, _networkPerson: np || null };
          });
          _renderStructuredResult({
            text: parsed.summary || '',
            action: parsed.action,
            people: matchedPeople,
            suggestWebSearch: parsed.suggest_web_search || false,
            message: parsed.message || '',
            suggestions: parsed.suggestions || [],
          }, lastUserMsg);
          continue;
        }

        // If discovery cards will be rendered, strip the bullet-point people list
        // from the message (keep only the summary line)
        if (hasDiscovery && content.includes('\n- ')) {
          content = content.split('\n- ')[0].trim();
        }
        _addMessage('assistant', _formatMarkdown(Chat.formatResponse(content, _data)), true);
      }
    }
  }

  /**
   * Try to parse an assistant message as a structured JSON result.
   * Returns the parsed object if it looks like a valid action, null otherwise.
   */
  function _tryParseStructured(content) {
    try {
      const trimmed = content.trim();
      if (!trimmed.startsWith('{')) return null;
      const obj = JSON.parse(trimmed);
      if (obj && obj.action && typeof obj.action === 'string') return obj;
    } catch { /* not JSON */ }
    return null;
  }

  // ─── Render Helpers ───
  function _addMessage(role, content, isHtml = false) {
    const container = document.getElementById('chatPageMessages');
    const div = document.createElement('div');
    div.className = `chat-page-msg ${role}`;
    if (isHtml) {
      div.innerHTML = content;
      // Bind click handlers on person chips
      div.querySelectorAll('.person-chip-enrichable').forEach(chip => {
        chip.addEventListener('click', () => {
          const idx = parseInt(chip.dataset.personIdx);
          const person = _data[idx];
          if (person) {
            const cached = Enricher.getCached(person);
            PersonModal.show(person, cached);
          }
        });
      });
      div.querySelectorAll('.person-chip-discovered').forEach(chip => {
        chip.addEventListener('click', () => {
          const url = chip.dataset.url;
          if (url) window.open(url, '_blank');
        });
      });
    } else {
      div.textContent = content;
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  /**
   * Markdown formatting for AI responses.
   * Input may contain HTML (person chips from formatResponse) mixed with markdown.
   * Handles: headers, lists, horizontal rules, line breaks.
   */
  function _formatMarkdown(html) {
    // Inline conversions: **bold** and *italic*
    // Italic must avoid matching the second * of bold — require non-* characters inside
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

    // Inline links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="chat-md-link">$1</a>');

    // Inline code: `code`
    html = html.replace(/`([^`\n]+)`/g, '<code class="chat-md-code">$1</code>');

    // Split into lines, process each
    const lines = html.split('\n');
    const out = [];
    let inUl = false;
    let inOl = false;
    let inDl = false; // definition list for **Label:** value

    const closeBlocks = () => {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (inDl) { out.push('</dl>'); inDl = false; }
    };

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines — close any open block
      if (!trimmed) {
        closeBlocks();
        continue;
      }

      // Headers (#### → h5, ### → h4, ## → h3, # → h2)
      const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (hMatch) {
        closeBlocks();
        const level = hMatch[1].length; // 1..4
        const cls = level === 1 ? 'chat-md-h2' : level === 2 ? 'chat-md-h3' : level === 3 ? 'chat-md-h4' : 'chat-md-h5';
        out.push(`<div class="${cls}">${hMatch[2]}</div>`);
        continue;
      }

      // Horizontal rule
      if (/^---+$/.test(trimmed)) {
        closeBlocks();
        out.push('<hr class="chat-md-hr">');
        continue;
      }

      // Unordered list item — handle nested **Label:** value styling
      if (/^[-*]\s+/.test(trimmed)) {
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (inDl) { out.push('</dl>'); inDl = false; }
        if (!inUl) { out.push('<ul class="chat-md-ul">'); inUl = true; }
        const itemContent = trimmed.replace(/^[-*]\s+/, '');
        // Detect "<strong>Label:</strong> value" pattern in list items
        const kv = itemContent.match(/^<strong>([^<]+):<\/strong>\s*(.+)$/);
        if (kv) {
          out.push(`<li class="chat-md-li-kv"><span class="chat-md-li-key">${kv[1]}</span><span class="chat-md-li-val">${kv[2]}</span></li>`);
        } else {
          out.push(`<li>${itemContent}</li>`);
        }
        continue;
      }

      // Ordered list item
      if (/^\d+\.\s/.test(trimmed)) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inDl) { out.push('</dl>'); inDl = false; }
        if (!inOl) { out.push('<ol class="chat-md-ol">'); inOl = true; }
        out.push(`<li>${trimmed.replace(/^\d+\.\s/, '')}</li>`);
        continue;
      }

      // Definition-list-like: paragraph that starts with "<strong>Label:</strong> value"
      // Render as a clean two-column row
      const kvPara = trimmed.match(/^<strong>([^<]+):<\/strong>\s*(.+)$/);
      if (kvPara) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (!inDl) { out.push('<dl class="chat-md-dl">'); inDl = true; }
        out.push(`<dt>${kvPara[1]}</dt><dd>${kvPara[2]}</dd>`);
        continue;
      }

      // Regular text
      closeBlocks();
      out.push(`<p class="chat-md-p">${trimmed}</p>`);
    }

    closeBlocks();
    return out.join('');
  }

  /**
   * Extract all **Name** mentions from AI text and render cards.
   * Matches network connections AND parses discovered people from the text.
   */
  function _addMentionedPeopleCards(rawText) {
    if (!rawText) return false;

    // Extract all bold names
    const nameMatches = [];
    const regex = /\*\*([^*]+)\*\*/g;
    let m;
    while ((m = regex.exec(rawText)) !== null) {
      nameMatches.push(m[1].trim());
    }

    if (!nameMatches.length) return false;

    // Match to network data
    const networkMatched = [];
    const discoveredPeople = [];
    const seen = new Set();

    for (const name of nameMatches) {
      const nameLower = name.toLowerCase();
      if (seen.has(nameLower)) continue;
      seen.add(nameLower);

      const person = _data.find(p => {
        const fullName = `${p.f} ${p.l}`.toLowerCase();
        return fullName === nameLower ||
          fullName.includes(nameLower) ||
          nameLower.includes(fullName);
      });

      if (person) {
        networkMatched.push({ person, score: 0, why: '' });
      } else {
        // Try to extract role/company from the text near the name
        const nameEsc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Look for patterns like "Name - Title, Company" or "Name — Title at Company"
        const contextRegex = new RegExp(`\\*\\*${nameEsc}\\*\\*\\s*[-—–:]\\s*([^\\n]+)`, 'i');
        const contextMatch = rawText.match(contextRegex);
        let title = '', company = '', context = '';

        if (contextMatch) {
          const desc = contextMatch[1].trim();
          // Try "Title, Company" or "Title at Company"
          const atMatch = desc.match(/^(.+?)(?:,\s*|\s+at\s+)(.+?)(?:\.|$)/i);
          if (atMatch) {
            title = atMatch[1].trim();
            company = atMatch[2].trim();
          } else {
            context = desc;
          }
        }

        // Only add if it looks like a real person name
        const words = name.split(/\s+/);
        const looksLikeName = words.length >= 2 && words.length <= 5
          && words.every(w => /^[A-Z]/.test(w)) // each word starts uppercase
          && !/\b(no|the|and|or|in|at|for|to|on|is|are|was|search|match|network|internet|your|you)\b/i.test(name);
        if (looksLikeName) {
          discoveredPeople.push({ name, title, company, context, linkedin: '', source: '' });
        }
      }
    }

    const hasCards = networkMatched.length > 0 || discoveredPeople.length > 0;
    if (networkMatched.length > 0) {
      _addPersonCards(networkMatched);
    }
    if (discoveredPeople.length > 0) {
      _addDiscoveryResults(discoveredPeople, '');
    }
    return hasCards;
  }

  function _addPersonCards(results) {
    const container = document.getElementById('chatPageMessages');
    // Use same disc-grid layout as discovery results
    const wrapper = document.createElement('div');
    wrapper.className = 'disc-results';

    const header = document.createElement('div');
    header.className = 'disc-results-header';
    header.innerHTML = `<span class="disc-results-count">${results.length}</span><span>people found</span>`;
    wrapper.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'disc-grid';

    const avatarColors = ['#C0785C', '#8B7EC8', '#3E7B97', '#4A8F72', '#C4953A', '#7E8EA6', '#9B6B8A'];

    results.forEach((r, i) => {
      const p = r.person;
      const cat = Categorizer.CATEGORIES[p._cat];
      const initials = (p.f[0] || '') + (p.l[0] || '');
      const color = cat?.color || avatarColors[i % avatarColors.length];

      const card = document.createElement('div');
      card.className = 'disc-card';
      card.style.cursor = 'pointer';
      card.style.animationDelay = `${i * 0.03}s`;

      card.innerHTML = `
        <div class="disc-card-row">
          <div class="disc-card-avatar" style="background:${color}">${initials}</div>
          <div class="disc-card-body">
            <div class="disc-card-name">${p.f} ${p.l}</div>
            <div class="disc-card-role">${_esc(p.p || '')}${p.c ? ` at ${_esc(p.c)}` : ''}</div>
            ${p.e ? `<div class="disc-card-context">${_esc(p.e)}</div>` : ''}
          </div>
          <div class="disc-card-links">
            ${p.u ? `<a href="${_esc(p.u)}" target="_blank" class="disc-link" title="LinkedIn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45z"/></svg>
            </a>` : ''}
          </div>
        </div>
      `;

      // Click opens modal
      card.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        const cached = Enricher.getCached(p);
        PersonModal.show(p, cached);
      });

      grid.appendChild(card);
    });

    wrapper.appendChild(grid);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  // ─── Enrichment Progress ───
  function _updateEnrichProgress(status, done, total, query) {
    const container = document.getElementById('chatPageMessages');
    let bar = document.getElementById('enrichProgressBar');

    // Hide typing dots — progress bar replaces them
    _showTyping(false);

    if (status === 'start') {
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'enrichProgressBar';
        bar.className = 'enrich-progress';
        container.appendChild(bar);
      }
      bar.innerHTML = `
        <div class="enrich-progress-icon">🔍</div>
        <div class="enrich-progress-text">
          <div class="enrich-progress-title">Searching backgrounds for "${query}"</div>
          <div class="enrich-progress-detail">Checking <strong>0</strong> of <strong>${total}</strong> candidates...</div>
          <div class="enrich-progress-bar-track"><div class="enrich-progress-bar-fill" style="width:0%"></div></div>
        </div>
      `;
      container.scrollTop = container.scrollHeight;
    } else if (status === 'progress' && bar) {
      const pct = Math.round((done / total) * 100);
      const detail = bar.querySelector('.enrich-progress-detail');
      const fill = bar.querySelector('.enrich-progress-bar-fill');
      if (detail) detail.innerHTML = `Checking <strong>${done}</strong> of <strong>${total}</strong> candidates...`;
      if (fill) fill.style.width = pct + '%';
      container.scrollTop = container.scrollHeight;
    } else if (status === 'done' && bar) {
      const detail = bar.querySelector('.enrich-progress-detail');
      const fill = bar.querySelector('.enrich-progress-bar-fill');
      if (detail) detail.innerHTML = `<strong>${done}</strong> backgrounds searched — compiling results...`;
      if (fill) fill.style.width = '100%';
    }
  }

  function _hideEnrichProgress() {
    ['enrichProgressBar', 'discoveryProgressBar'].forEach(id => {
      const bar = document.getElementById(id);
      if (bar) {
        bar.style.opacity = '0';
        bar.style.transition = 'opacity 0.3s';
        setTimeout(() => bar.remove(), 300);
      }
    });
  }

  // ─── Per-search tick (fires each time Tavily is called via tool use) ───
  function _updateSearchTick(count, query) {
    const bar = document.getElementById('discoveryProgressBar');
    if (bar) {
      const sub = bar.querySelector('.disc-progress-sub');
      if (sub) sub.textContent = `Search ${count}: ${query}`;
      const container = document.getElementById('chatPageMessages');
      if (container) container.scrollTop = container.scrollHeight;
      return;
    }
    // No discovery bar — must be single enrichment. Show research indicator.
    if (!document.getElementById('chatResearchIndicator')) {
      _showResearching('Researching');
    }
    _updateResearchSub(`Search ${count}: ${query}`);
  }

  // ─── Batch Enrichment Cards ───
  function _addBatchEnrichCards(results, query) {
    const container = document.getElementById('chatPageMessages');
    const wrapper = document.createElement('div');
    wrapper.className = 'enrich-batch-wrapper';

    const header = document.createElement('div');
    header.className = 'enrich-batch-header';
    header.innerHTML = `🔍 Found <strong>${results.length}</strong> hidden connection${results.length !== 1 ? 's' : ''} to "${query}" via background search`;
    wrapper.appendChild(header);

    results.forEach(({ person, profile }) => {
      if (!profile) return;
      const card = document.createElement('div');
      card.className = 'enrich-card enrich-card-mini';

      const cat = Categorizer.CATEGORIES[person._cat];
      let details = '';

      // Show the relevant match detail prominently
      const qLower = query.toLowerCase();
      const matchedRole = profile.previousRoles?.find(r => `${r.company} ${r.title}`.toLowerCase().includes(qLower));
      const matchedEdu = profile.education?.find(e => `${e.school} ${e.field || ''} ${e.degree || ''}`.toLowerCase().includes(qLower));

      if (matchedRole) {
        details += `<div class="enrich-match-detail">↳ Previously <strong>${matchedRole.title}</strong> at <strong>${matchedRole.company}</strong>${matchedRole.period ? ` (${matchedRole.period})` : ''}</div>`;
      }
      if (matchedEdu) {
        details += `<div class="enrich-match-detail">↳ <strong>${matchedEdu.school}</strong>${matchedEdu.degree ? ' — ' + matchedEdu.degree : ''}${matchedEdu.field ? ' in ' + matchedEdu.field : ''}${matchedEdu.year ? ` (${matchedEdu.year})` : ''}</div>`;
      }

      card.innerHTML = `
        <div class="enrich-card-header">
          <div class="enrich-avatar" style="background:${cat?.color || '#999'}">${(person.f[0] || '') + (person.l[0] || '')}</div>
          <div>
            <div class="enrich-name">${person.f} ${person.l}</div>
            <div class="enrich-current">${person.p || ''} ${person.c ? 'at ' + person.c : ''}</div>
            ${details}
          </div>
          ${person.u ? `<a href="${person.u}" target="_blank" class="enrich-linkedin-link" title="View LinkedIn">↗</a>` : ''}
        </div>
      `;

      card.style.cursor = 'pointer';
      card.onclick = () => {
        // Clicking a mini card triggers full enrichment
        const input = document.getElementById('chatPageInput');
        input.value = `tell me about ${person.f} ${person.l}`;
        handleSend();
      };

      wrapper.appendChild(card);
    });

    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  // ─── Discovery Progress ───
  function _updateDiscoveryProgress(status, done, total, query) {
    const container = document.getElementById('chatPageMessages');

    // Hide typing dots — the progress bar replaces them visually
    _showTyping(false);

    let bar = document.getElementById('discoveryProgressBar');

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'discoveryProgressBar';
      bar.className = 'disc-progress';
      container.appendChild(bar);
    }

    if (status === 'generating' || status === 'searching') {
      bar.innerHTML = `
        <div class="disc-progress-inner">
          <div class="disc-progress-orbit">
            <div class="disc-orbit-dot"></div>
            <div class="disc-orbit-dot"></div>
            <div class="disc-orbit-dot"></div>
          </div>
          <div class="disc-progress-body">
            <div class="disc-progress-label">Searching the web</div>
            <div class="disc-progress-sub">Finding people and profiles...</div>
          </div>
        </div>
      `;
      container.scrollTop = container.scrollHeight;
    } else if (status === 'extracting') {
      const body = bar.querySelector('.disc-progress-body');
      if (body) {
        body.querySelector('.disc-progress-label').textContent = 'Compiling results';
        body.querySelector('.disc-progress-sub').textContent = 'Extracting names and profiles...';
      }
    }
  }

  // ─── Discovery Results Cards ───
  function _addDiscoveryResults(people, query) {
    const container = document.getElementById('chatPageMessages');
    const wrapper = document.createElement('div');
    wrapper.className = 'disc-results';

    const header = document.createElement('div');
    header.className = 'disc-results-header';
    header.innerHTML = `
      <span class="disc-results-count">${people.length}</span>
      <span>people found</span>
    `;
    wrapper.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'disc-grid';

    // Color palette for avatars
    const avatarColors = ['#C0785C', '#8B7EC8', '#3E7B97', '#4A8F72', '#C4953A', '#7E8EA6', '#9B6B8A', '#5A8A6E', '#B07850', '#6B8FB5'];

    people.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'disc-card';
      card.style.animationDelay = `${i * 0.04}s`;
      if (p.inNetwork) card.classList.add('disc-card-network');

      const initials = p.name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
      const color = p.inNetwork ? '#4A8F72' : avatarColors[i % avatarColors.length];

      const confidenceColor = { high: '#4A8F72', medium: '#C4953A', low: '#C0785C' }[p.confidence] || '';
      const evidenceText = p.evidence || p.context || '';

      card.innerHTML = `
        <div class="disc-card-row">
          <div class="disc-card-avatar" style="background:${color}">${initials}</div>
          <div class="disc-card-body">
            <div class="disc-card-name">${_esc(p.name)}${p.inNetwork ? '<span class="disc-network-tag">In network</span>' : ''}${p.confidence ? `<span class="disc-confidence-tag" style="color:${confidenceColor}">${_esc(p.confidence)}</span>` : ''}</div>
            <div class="disc-card-role">${_esc(p.title || '')}${p.company ? ` at ${_esc(p.company)}` : ''}</div>
            ${p.email ? `<div class="disc-card-contact"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 4l-10 8L2 4"/></svg><a href="mailto:${_esc(p.email)}">${_esc(p.email)}</a></div>` : ''}
            ${p.phone ? `<div class="disc-card-contact"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg><a href="tel:${_esc(p.phone)}">${_esc(p.phone)}</a></div>` : ''}
            ${evidenceText ? `<div class="disc-card-context">${_esc(evidenceText)}</div>` : ''}
          </div>
          <div class="disc-card-links">
            ${p.linkedin ? `<a href="${_esc(p.linkedin)}" target="_blank" class="disc-link" title="LinkedIn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45z"/></svg>
            </a>` : ''}
            ${p.source ? `<a href="${_esc(p.source)}" target="_blank" class="disc-link disc-link-src" title="Source">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>` : ''}
          </div>
        </div>
      `;

      // Make entire card clickable → open modal
      card.style.cursor = 'pointer';
      card.addEventListener('click', (e) => {
        // Don't trigger if clicking a link
        if (e.target.closest('a')) return;
        if (p.inNetwork) {
          // In-network person — use full enrichment
          const cached = Enricher.getCached(p.inNetwork);
          PersonModal.show(p.inNetwork, cached, { relevance: p.context || '', avatarColor: '#4A8F72' });
        } else {
          // Discovered person — show what we have, enrich if possible
          PersonModal.showDiscovered(p);
        }
      });

      grid.appendChild(card);
    });

    wrapper.appendChild(grid);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  function _esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Render a table card in chat. Shows preview rows + actions.
   * opts: { isImport, isResult, addedColumns }
   */
  function _addTableCard(table, opts = {}) {
    const container = document.getElementById('chatPageMessages');
    const card = document.createElement('div');
    card.className = 'chat-table-card';

    const rowCount = table.rows.length;
    const colCount = table.headers.length;
    const previewRows = table.rows.slice(0, 5);

    const labelText = opts.isImport
      ? (table.source === 'upload' ? `Loaded ${_esc(table.filename || 'file')}` : 'Loaded pasted table')
      : (opts.isResult ? 'Enriched table' : 'Table');

    let subText;
    if (opts.isResult) {
      const parts = [];
      const counts = opts.filledCounts || {};
      (opts.filledColumns || []).forEach(c => {
        const k = counts[c.name];
        if (k && k.attempted > 0) parts.push(`${k.found}/${k.attempted} ${_esc(c.name)} filled`);
        else parts.push(`${_esc(c.name)}: nothing missing`);
      });
      (opts.addedColumns || []).forEach(c => {
        const k = counts[c.name];
        if (k && k.attempted > 0) parts.push(`${k.found}/${k.attempted} ${_esc(c.name)} found`);
      });
      parts.push(`${rowCount} rows`);
      subText = parts.join(' · ');
    } else {
      subText = `${rowCount} rows · ${colCount} columns`;
    }

    const headerRow = table.headers.map(h => `<th>${_esc(h)}</th>`).join('');
    const dataRows = previewRows.map(r =>
      `<tr>${table.headers.map((_, i) => `<td>${_esc(r[i] || '')}</td>`).join('')}</tr>`
    ).join('');

    const moreRows = rowCount > previewRows.length
      ? `<div class="chat-table-more">+ ${rowCount - previewRows.length} more rows</div>`
      : '';

    const actions = opts.isResult
      ? `<button class="chat-table-btn chat-table-copy" title="Copy as TSV (paste straight into Excel)">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
           Copy
         </button>
         <button class="chat-table-btn chat-table-download" title="Download as CSV">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
           Download CSV
         </button>`
      : `<button class="chat-table-btn chat-table-clear" title="Clear loaded table">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
           Clear
         </button>`;

    card.innerHTML = `
      <div class="chat-table-header">
        <div class="chat-table-info">
          <div class="chat-table-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
            ${_esc(labelText)}
          </div>
          <div class="chat-table-sub">${subText}</div>
        </div>
        <div class="chat-table-actions">${actions}</div>
      </div>
      <div class="chat-table-scroll">
        <table class="chat-table-data">
          <thead><tr>${headerRow}</tr></thead>
          <tbody>${dataRows}</tbody>
        </table>
      </div>
      ${moreRows}
    `;

    // Bind action handlers
    if (opts.isResult) {
      card.querySelector('.chat-table-copy')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        try {
          const tsv = TableImport.toTsv(table.headers, table.rows);
          await navigator.clipboard.writeText(tsv);
          btn.classList.add('copied');
          const orig = btn.innerHTML;
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied';
          setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = orig; }, 1800);
        } catch {
          btn.textContent = 'Copy failed';
        }
      });
      card.querySelector('.chat-table-download')?.addEventListener('click', () => {
        const csv = TableImport.toCsv(table.headers, table.rows);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = url; a.download = `enriched_${stamp}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      });
    } else {
      card.querySelector('.chat-table-clear')?.addEventListener('click', () => {
        ChatState.clearCurrentTable();
        card.remove();
        const input = document.getElementById('chatPageInput');
        if (input) input.placeholder = 'Follow up or start a new search...';
      });
    }

    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
  }

  /**
   * Show / update a progress bar while a table is being enriched per-row.
   */
  function _showTableEnrichProgress(stage, done, total, columns) {
    const container = document.getElementById('chatPageMessages');
    let bar = document.getElementById('tableEnrichProgress');
    if (stage === 'done') { bar?.remove(); return; }

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'tableEnrichProgress';
      bar.className = 'chat-table-progress';
      bar.innerHTML = `
        <div class="chat-table-progress-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
        </div>
        <div class="chat-table-progress-body">
          <div class="chat-table-progress-title"></div>
          <div class="chat-table-progress-detail"></div>
          <div class="chat-table-progress-track"><div class="chat-table-progress-fill"></div></div>
        </div>
      `;
      container.appendChild(bar);
    }
    const cols = columns?.length ? columns.map(c => c.name).join(', ') : 'fields';
    bar.querySelector('.chat-table-progress-title').textContent = `Enriching ${cols}`;
    bar.querySelector('.chat-table-progress-detail').textContent = `${done} of ${total} rows`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    bar.querySelector('.chat-table-progress-fill').style.width = `${pct}%`;
    container.scrollTop = container.scrollHeight;
  }

  function _addEnrichedProfile(person, profile) {
    if (!profile) return;
    const container = document.getElementById('chatPageMessages');
    const card = document.createElement('div');
    card.className = 'enrich-card';

    const cat = Categorizer.CATEGORIES[person._cat];
    const header = `
      <div class="enrich-card-header">
        <div class="enrich-avatar" style="background:${cat?.color || '#999'}">${(person.f[0] || '') + (person.l[0] || '')}</div>
        <div>
          <div class="enrich-name">${person.f} ${person.l}</div>
          <div class="enrich-current">${person.p || ''} ${person.c ? 'at ' + person.c : ''}</div>
        </div>
        ${person.u ? `<a href="${person.u}" target="_blank" class="enrich-linkedin-link" title="View LinkedIn">↗</a>` : ''}
      </div>
    `;

    card.innerHTML = header + Enricher.formatProfileHtml(person, profile);
    card.style.cursor = 'pointer';
    card.title = 'Click to open full profile';
    card.addEventListener('click', () => {
      PersonModal.show(person, profile);
    });
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
  }

  function _showTyping(show) {
    const el = document.getElementById('chatPageTyping');
    if (el) el.classList.toggle('visible', show);
  }

  /**
   * Show a richer "researching" indicator in chat with an animated icon
   * and a sub-label that updates as web searches fire.
   */
  function _showResearching(label) {
    _showTyping(false);
    let el = document.getElementById('chatResearchIndicator');
    const container = document.getElementById('chatPageMessages');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chatResearchIndicator';
      el.className = 'chat-research-indicator';
      el.innerHTML = `
        <div class="chat-research-orbit">
          <span class="chat-research-pulse"></span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <div class="chat-research-text">
          <div class="chat-research-label"></div>
          <div class="chat-research-sub"></div>
        </div>
      `;
      container.appendChild(el);
    }
    el.querySelector('.chat-research-label').textContent = label || 'Researching…';
    el.querySelector('.chat-research-sub').textContent = 'Gathering background info';
    container.scrollTop = container.scrollHeight;
  }

  function _updateResearchSub(text) {
    const el = document.getElementById('chatResearchIndicator');
    if (!el) return;
    const sub = el.querySelector('.chat-research-sub');
    if (sub) sub.textContent = text;
    const container = document.getElementById('chatPageMessages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  function _hideResearching() {
    const el = document.getElementById('chatResearchIndicator');
    if (el) el.remove();
  }

  function _updateTokenCounter() {
    const el = document.getElementById('chatPageTokens');
    if (el) {
      const tokens = AIProvider.getTotalTokens();
      const cost = AIProvider.getEstimatedCost();
      if (tokens > 0) {
        el.textContent = `${tokens.toLocaleString()} tokens · ~$${cost}`;
      }
    }
  }

  /**
   * Update data after reclassification.
   */
  function refreshData(data) {
    _data = data;
    Chat.buildNetworkSummary(data);
    _updateAIStatus();
    _updateClassifyBtn();
    // Update welcome message if still showing
    const welcome = document.querySelector('.chat-page-welcome p');
    if (welcome) {
      welcome.textContent = `Search your ${_data.length.toLocaleString()} connections or find new people on the web.`;
    }
    const sub = document.getElementById('chatPageSub');
    if (sub) {
      const p = AIProvider.getProvider();
      const names = { openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };
      sub.textContent = p
        ? `${names[p]} connected · ${_data.length} connections`
        : `Local search · ${_data.length} connections`;
    }
  }

  // ─── Past Chats (multi-session) ───
  let _chatHistory = _loadChatHistory();
  let _activeChatId = _chatHistory.find(c => !c.done)?.id || null;

  function _genChatId() { return 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

  function _saveChatHistory() {
    try { localStorage.setItem('chat_history', JSON.stringify(_chatHistory.slice(-20))); }
    catch { /* ignore */ }
  }

  function _loadChatHistory() {
    try {
      const saved = localStorage.getItem('chat_history');
      if (!saved) return [];
      const history = JSON.parse(saved);
      // Migrate old entries that don't have an id
      let migrated = false;
      for (const chat of history) {
        if (!chat.id) {
          chat.id = 'chat_' + (chat.time || Date.now()) + '_' + Math.random().toString(36).slice(2, 6);
          migrated = true;
        }
      }
      if (migrated) {
        localStorage.setItem('chat_history', JSON.stringify(history));
      }
      return history;
    } catch { return []; }
  }

  function _saveChatSession(chatId) {
    if (!chatId) return;
    // Save a SNAPSHOT of current messages + discovery (deep copy, not reference)
    try {
      const messages = JSON.parse(JSON.stringify(Chat.getMessages()));
      const discovery = Chat.getLastDiscovery();
      const session = {
        messages,
        discovery: discovery ? JSON.parse(JSON.stringify(discovery)) : null,
      };
      localStorage.setItem('chat_session_' + chatId, JSON.stringify(session));
    } catch (e) { console.warn('Failed to save chat session:', e); }
  }

  function _loadChatSession(chatId) {
    try {
      const saved = localStorage.getItem('chat_session_' + chatId);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  }

  function _addToChatHistory(msg) {
    // Create new session on first message or after previous was marked done
    if (!_activeChatId || !_chatHistory.length || _chatHistory[_chatHistory.length - 1].done) {
      const id = _genChatId();
      _chatHistory.push({ id, title: msg.slice(0, 40), time: Date.now(), done: false });
      _activeChatId = id;
      // Generate a nice short title asynchronously
      _generateChatTitle(id, msg);
    }
    _saveChatHistory();
    _saveChatSession(_activeChatId);
    _renderChatHistory();
    _updateBreadcrumb();
  }

  async function _generateChatTitle(chatId, userMessage) {
    try {
      const { text } = await AIProvider.aiCall(
        'Generate a very short chat title (2-5 words, no quotes, no punctuation) that summarizes this networking query. Just output the title, nothing else.',
        userMessage,
        { temperature: 0.3, maxTokens: 20 }
      );
      const title = (text || '').trim().replace(/^["']|["']$/g, '').slice(0, 40);
      if (!title) return;
      const chat = _chatHistory.find(c => c.id === chatId);
      if (chat) {
        chat.title = title;
        _saveChatHistory();
        _renderChatHistory();
        _updateBreadcrumb();
      }
    } catch (e) {
      console.warn('Title generation failed:', e);
    }
  }

  function _markChatDone() {
    if (_chatHistory.length) _chatHistory[_chatHistory.length - 1].done = true;
    if (_activeChatId) _saveChatSession(_activeChatId);
    _saveChatHistory();
  }

  function _switchToChat(chatId) {
    if (!chatId) return;

    // Save current chat first
    if (_activeChatId) _saveChatSession(_activeChatId);

    // Load the target session
    const session = _loadChatSession(chatId);
    _activeChatId = chatId;

    // Clear UI
    const container = document.getElementById('chatPageMessages');
    if (container) container.innerHTML = '';

    // Restore Chat module state from the saved session
    Chat.restoreMessages(session?.messages || []);
    Chat.setLastDiscovery(session?.discovery || null);

    if (session?.messages?.length) {
      const hasDisc = session.discovery?.people?.length > 0;
      _restoreSavedMessages(session.messages, hasDisc);

      // Restore discovery cards below the messages
      if (hasDisc) {
        _addDiscoveryResults(session.discovery.people, session.discovery.query);
      }
    } else {
      // Only show welcome on truly new chats, not on empty saved sessions
      const chat = _chatHistory.find(c => c.id === chatId);
      if (!chat || chat.title === 'New chat') {
        _renderWelcome();
      }
    }

    _renderChatHistory();
    _updateBreadcrumb();
  }

  function _updateBreadcrumb() {
    const el = document.getElementById('chatBreadcrumbTitle');
    if (!el) return;
    const chat = _chatHistory.find(c => c.id === _activeChatId);
    el.textContent = chat?.title || 'New chat';
    el.title = chat ? 'Double-click to rename' : '';
    // Remove any existing listener to avoid duplicates
    el.ondblclick = chat ? () => _startRenameBreadcrumb(chat.id) : null;
  }

  function _startRenameBreadcrumb(chatId) {
    const el = document.getElementById('chatBreadcrumbTitle');
    if (!el) return;
    const chat = _chatHistory.find(c => c.id === chatId);
    if (!chat) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = chat.title;
    input.className = 'chat-breadcrumb-edit';
    el.replaceWith(input);
    input.focus();
    input.select();

    const finish = (save) => {
      const newTitle = save ? input.value.trim() : chat.title;
      if (save && newTitle && newTitle !== chat.title) {
        chat.title = newTitle.slice(0, 60);
        _saveChatHistory();
        _renderChatHistory();
      }
      const span = document.createElement('span');
      span.className = 'chat-breadcrumb-current';
      span.id = 'chatBreadcrumbTitle';
      span.textContent = chat.title;
      input.replaceWith(span);
      _updateBreadcrumb();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function _renderChatHistory() {
    const container = document.getElementById('sidebarChats');
    if (!container) return;
    container.innerHTML = '';

    const recent = [..._chatHistory].reverse().slice(0, 10);
    recent.forEach(chat => {
      const item = document.createElement('div');
      item.className = `sidebar-chat-item${chat.id === _activeChatId ? ' active' : ''}`;
      item.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span class="sidebar-chat-title">${_esc(chat.title)}</span>
        <button class="sidebar-chat-rename" title="Rename chat">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        </button>
        <button class="sidebar-chat-delete" title="Delete chat">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
        </button>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.sidebar-chat-rename')) return;
        if (e.target.closest('.sidebar-chat-delete')) return;
        if (chat.id !== _activeChatId) _switchToChat(chat.id);
      });
      item.querySelector('.sidebar-chat-rename').addEventListener('click', (e) => {
        e.stopPropagation();
        _startRenameSidebar(item, chat.id);
      });
      item.querySelector('.sidebar-chat-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${chat.title}"? This can't be undone.`)) {
          _deleteChat(chat.id);
        }
      });
      container.appendChild(item);
    });
  }

  function _deleteChat(chatId) {
    if (!chatId) return;
    // Remove from history list
    const idx = _chatHistory.findIndex(c => c.id === chatId);
    if (idx === -1) return;
    _chatHistory.splice(idx, 1);
    _saveChatHistory();
    // Remove session storage
    try { localStorage.removeItem('chat_session_' + chatId); } catch { /* ignore */ }
    // If we deleted the active chat, reset to a new chat state
    if (chatId === _activeChatId) {
      _activeChatId = null;
      Chat.clearHistory();
      const container = document.getElementById('chatPageMessages');
      if (container) container.innerHTML = '';
      _renderWelcome();
    }
    _renderChatHistory();
    _updateBreadcrumb();
  }

  function _startRenameSidebar(item, chatId) {
    const chat = _chatHistory.find(c => c.id === chatId);
    if (!chat) return;
    const titleEl = item.querySelector('.sidebar-chat-title');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = chat.title;
    input.className = 'sidebar-chat-edit';
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const finish = (save) => {
      const newTitle = save ? input.value.trim() : chat.title;
      if (save && newTitle && newTitle !== chat.title) {
        chat.title = newTitle.slice(0, 60);
        _saveChatHistory();
      }
      _renderChatHistory();
      if (chat.id === _activeChatId) _updateBreadcrumb();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  function _newChat() {
    _markChatDone();
    if (_activeChatId) _saveChatSession(_activeChatId);
    _activeChatId = null;
    Chat.clearHistory();
    const container = document.getElementById('chatPageMessages');
    if (container) container.innerHTML = '';
    const input = document.getElementById('chatPageInput');
    if (input) input.placeholder = 'Describe who you\'re looking for...';
    _renderWelcome();
    _renderChatHistory();
  }

  function _bindNewChatBtn() {
    const btn = document.getElementById('newChatBtn');
    if (btn) btn.addEventListener('click', _newChat);
  }

  // No-op toggle for backwards compatibility
  function toggle() {}

  return { init, toggle, handleSend, sendSuggestion, refreshData, updateClassificationStatus, finishClassification };
})();
