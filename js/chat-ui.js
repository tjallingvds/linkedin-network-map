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
      <h3>Discover people</h3>
      <p>Search your ${_data.length.toLocaleString()} connections or find new people on the web.</p>
    `;
    container.appendChild(welcome);
  }

  // ─── Input Events ───
  function _bindInputEvents() {
    const input = document.getElementById('chatPageInput');
    const sendBtn = document.getElementById('chatPageSend');

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    sendBtn.addEventListener('click', () => handleSend());
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
  function _renderAIStatus() {}
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

      // Show AI text response — inject web search form if no matches
      let formattedText = _formatMarkdown(Chat.formatResponse(result.text, _data));
      if (Enricher.isConfigured()) {
        formattedText = formattedText.replace(
          /(?:Try asking me to )?search (?:on )?the internet\.?/gi,
          `<div class="chat-web-search-form">
            <div class="chat-wsf-label">Search the web instead?</div>
            <div class="chat-wsf-row">
              <input type="number" class="chat-wsf-count" value="25" min="5" max="200" step="5" placeholder="# people">
              <button class="chat-wsf-go">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                Find people
              </button>
            </div>
          </div>`
        );
      }
      _addMessage('assistant', formattedText, true);

      // Bind web search form
      const container = document.getElementById('chatPageMessages');
      container.querySelectorAll('.chat-wsf-go').forEach(btn => {
        if (btn._bound) return;
        btn._bound = true;
        btn.addEventListener('click', () => {
          const form = btn.closest('.chat-web-search-form');
          const count = parseInt(form.querySelector('.chat-wsf-count').value) || 25;
          // Disable form to prevent double-clicks
          btn.disabled = true;
          btn.textContent = 'Searching...';
          form.querySelector('.chat-wsf-count').disabled = true;
          // Trigger discovery directly with the original query and explicit count
          _triggerWebDiscovery(msg, count);
        });
      });

      // Then show rich cards below the text
      if (result.enriched && result.profile && result.person) {
        _addEnrichedProfile(result.person, result.profile);
      }
      if (result.batchEnriched && result.results?.length > 0) {
        _addBatchEnrichCards(result.results, result.query);
      }
      if (result.discovered && result.people?.length > 0) {
        _addDiscoveryResults(result.people, result.query);
      }

      // Auto-render cards for people mentioned in text — but only if the formatted
      // response doesn't already contain person chips (avoids duplicate text + cards)
      if (!result.enriched && !result.discovered) {
        const formattedHtml = Chat.formatResponse(result.text, _data);
        const hasChips = formattedHtml.includes('person-chip');
        if (!hasChips) {
          _addMentionedPeopleCards(result.text);
        }
      }
      _updateTokenCounter();
      // Save session after each response
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
   * Trigger web discovery directly — bypasses classifier and AI extraction.
   * Takes the raw user query and an explicit count.
   */
  async function _triggerWebDiscovery(query, count) {
    _showTyping(true);
    const result = await Chat.discover(query, count);
    _showTyping(false);
    _hideEnrichProgress();

    _addMessage('assistant', _formatMarkdown(Chat.formatResponse(result.text, _data)), true);
    if (result.discovered && result.people?.length > 0) {
      _addDiscoveryResults(result.people, result.query);
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
  function _restoreSavedMessages(messages) {
    // Remove welcome screen
    const welcome = document.querySelector('.chat-page-welcome');
    if (welcome) welcome.remove();

    for (const msg of messages) {
      if (msg.role === 'user') {
        _addMessage('user', msg.content);
      } else if (msg.role === 'assistant') {
        _addMessage('assistant', _formatMarkdown(Chat.formatResponse(msg.content, _data)), true);
      }
    }
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
    // First pass: convert remaining **bold** and *italic* that formatResponse didn't handle
    // (formatResponse only converts **Name** to chips for known people)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Split into lines, process each
    const lines = html.split('\n');
    const out = [];
    let inUl = false;
    let inOl = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines — close any open list
      if (!trimmed) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        continue;
      }

      // Headers
      if (/^### /.test(trimmed)) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        out.push(`<div class="chat-md-h4">${trimmed.slice(4)}</div>`);
        continue;
      }
      if (/^## /.test(trimmed)) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        out.push(`<div class="chat-md-h3">${trimmed.slice(3)}</div>`);
        continue;
      }

      // Horizontal rule
      if (/^---+$/.test(trimmed)) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        out.push('<hr class="chat-md-hr">');
        continue;
      }

      // Unordered list item
      if (/^[-*] /.test(trimmed)) {
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (!inUl) { out.push('<ul class="chat-md-ul">'); inUl = true; }
        out.push(`<li>${trimmed.slice(2)}</li>`);
        continue;
      }

      // Ordered list item
      if (/^\d+\.\s/.test(trimmed)) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (!inOl) { out.push('<ol class="chat-md-ol">'); inOl = true; }
        out.push(`<li>${trimmed.replace(/^\d+\.\s/, '')}</li>`);
        continue;
      }

      // Regular text
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      out.push(`<p class="chat-md-p">${trimmed}</p>`);
    }

    // Close any open lists
    if (inUl) out.push('</ul>');
    if (inOl) out.push('</ol>');

    return out.join('');
  }

  /**
   * Extract all **Name** mentions from AI text and render cards.
   * Matches network connections AND parses discovered people from the text.
   */
  function _addMentionedPeopleCards(rawText) {
    if (!rawText) return;

    // Extract all bold names
    const nameMatches = [];
    const regex = /\*\*([^*]+)\*\*/g;
    let m;
    while ((m = regex.exec(rawText)) !== null) {
      nameMatches.push(m[1].trim());
    }

    if (!nameMatches.length) return;

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

    if (networkMatched.length > 0) {
      _addPersonCards(networkMatched);
    }
    // Don't render cards for text-parsed "discovered" names — too error-prone.
    // Discovery cards only come from actual web search results via _addDiscoveryResults.
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
    if (!bar) return;
    const sub = bar.querySelector('.disc-progress-sub');
    if (sub) {
      sub.textContent = `Search ${count}: ${query}`;
    }
    const container = document.getElementById('chatPageMessages');
    if (container) container.scrollTop = container.scrollHeight;
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

      card.innerHTML = `
        <div class="disc-card-row">
          <div class="disc-card-avatar" style="background:${color}">${initials}</div>
          <div class="disc-card-body">
            <div class="disc-card-name">${_esc(p.name)}${p.inNetwork ? '<span class="disc-network-tag">In network</span>' : ''}</div>
            <div class="disc-card-role">${_esc(p.title || '')}${p.company ? ` at ${_esc(p.company)}` : ''}</div>
            ${p.context ? `<div class="disc-card-context">${_esc(p.context)}</div>` : ''}
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
          PersonModal.show(p.inNetwork, cached);
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
    // Save current messages + discovery results under this chat ID
    try {
      const session = {
        messages: Chat.getMessages(),
        discovery: Chat.getLastDiscovery(),
      };
      localStorage.setItem('chat_session_' + chatId, JSON.stringify(session));
    } catch { /* ignore */ }
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
      _chatHistory.push({ id, title: msg.slice(0, 50), time: Date.now(), done: false });
      _activeChatId = id;
    }
    _saveChatHistory();
    _saveChatSession(_activeChatId);
    _renderChatHistory();
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

    // Clear Chat module state without saving (we don't want to overwrite stored sessions)
    Chat.getMessages().length = 0;

    if (session?.messages?.length) {
      // Rebuild _messages in Chat module
      for (const msg of session.messages) {
        Chat.getMessages().push(msg);
      }
      _restoreSavedMessages(session.messages);

      // Restore discovery cards
      if (session.discovery?.people?.length > 0) {
        _addDiscoveryResults(session.discovery.people, session.discovery.query);
      }
    } else {
      // No saved session data — show welcome
      _renderWelcome();
    }

    _renderChatHistory();
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
        <span>${_esc(chat.title)}</span>
      `;
      item.addEventListener('click', () => {
        if (chat.id !== _activeChatId) _switchToChat(chat.id);
      });
      container.appendChild(item);
    });
  }

  function _newChat() {
    _markChatDone();
    if (_activeChatId) _saveChatSession(_activeChatId);
    _activeChatId = null;
    Chat.clearHistory();
    const container = document.getElementById('chatPageMessages');
    if (container) container.innerHTML = '';
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
