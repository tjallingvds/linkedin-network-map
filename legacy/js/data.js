/**
 * Data loading and industry classification.
 * Contains the company-to-industry map and CSV parser.
 */

const DataLoader = (() => {

  const COMPANY_INDUSTRY_MAP = {"Ares Intelligence":"AI & Machine Learning","Bloomberg":"Software & Developer Tools","Fuse Energy":"Climate & Energy","AECOM":"Consulting & Professional Services","Toolio":"Software & Developer Tools","Entrepreneurs First":"Startups & Accelerators","Eliot AI":"AI & Machine Learning","PolyAI":"AI & Machine Learning","Seamflow":"Startups & Accelerators","Studio ThusThat":"Media & Creative","NewOrbit Space":"Robotics, Space & Hardware","XYZ Robotics Inc.":"Robotics, Space & Hardware","InstaDeep":"AI & Machine Learning","Business Systems International":"AI & Machine Learning","DeepTechForum":"Startups & Accelerators","Plug and Play Tech Center":"Startups & Accelerators","Behaviour Lab":"AI & Machine Learning","Ergon Informatik AG":"Software & Developer Tools","QuantCo":"Software & Developer Tools","Microsoft":"Big Tech","Creator Fund":"Venture Capital & Investment","LSESU Blockchain Society":"Startups & Accelerators","Harvard Medical School":"Healthcare & Biotech","NALA":"Fintech & Financial Services","Redbus Ventures":"Venture Capital & Investment","Objective Labs":"AI & Machine Learning","The Bridge":"Venture Capital & Investment","Stealth AI Startup":"AI & Machine Learning","miora":"Consumer & Retail","foam":"AI & Machine Learning","Novogaia":"Climate & Energy","Borderless Capital":"Venture Capital & Investment","Colosseum":"Software & Developer Tools","Toptal":"Software & Developer Tools","BeamUP":"AI & Machine Learning","Bain & Company":"Consulting & Professional Services","Techstars":"Startups & Accelerators","Oliver Wyman":"Consulting & Professional Services","Citigroup":"Fintech & Financial Services","EF (Entrepreneur First)":"Startups & Accelerators","The Exploration Company":"Robotics, Space & Hardware","Lakestar":"Venture Capital & Investment","McKinsey & Company":"Consulting & Professional Services","Schmidt Futures":"Venture Capital & Investment","Minerva University":"Startups & Accelerators","Apple":"Big Tech","Google":"Big Tech","Meta":"Big Tech","Amazon":"Big Tech","Netflix":"Big Tech","Stripe":"Fintech & Financial Services","SpaceX":"Robotics, Space & Hardware","Tesla":"Climate & Energy","Palantir Technologies":"Software & Developer Tools","Databricks":"AI & Machine Learning","OpenAI":"AI & Machine Learning","Anthropic":"AI & Machine Learning","Cohere":"AI & Machine Learning","Mistral AI":"AI & Machine Learning","Hugging Face":"AI & Machine Learning","DeepMind":"AI & Machine Learning","Y Combinator":"Startups & Accelerators","Sequoia Capital":"Venture Capital & Investment","a16z":"Venture Capital & Investment","Andreessen Horowitz":"Venture Capital & Investment","Accel":"Venture Capital & Investment","Index Ventures":"Venture Capital & Investment","Lightspeed Venture Partners":"Venture Capital & Investment","Greylock Partners":"Venture Capital & Investment","Benchmark":"Venture Capital & Investment","General Catalyst":"Venture Capital & Investment","Kleiner Perkins":"Venture Capital & Investment","NEA":"Venture Capital & Investment","Insight Partners":"Venture Capital & Investment","Tiger Global Management":"Venture Capital & Investment","Softbank":"Venture Capital & Investment","Goldman Sachs":"Fintech & Financial Services","JPMorgan Chase":"Fintech & Financial Services","Morgan Stanley":"Fintech & Financial Services","Deloitte":"Consulting & Professional Services","PwC":"Consulting & Professional Services","EY":"Consulting & Professional Services","KPMG":"Consulting & Professional Services","BCG":"Consulting & Professional Services","Accenture":"Consulting & Professional Services","IBM":"Big Tech","Oracle":"Software & Developer Tools","Salesforce":"Software & Developer Tools","SAP":"Software & Developer Tools","Adobe":"Software & Developer Tools","Nvidia":"Big Tech","Intel":"Big Tech","AMD":"Big Tech","Qualcomm":"Robotics, Space & Hardware","Cisco":"Software & Developer Tools","VMware":"Software & Developer Tools","Snowflake":"Software & Developer Tools","Twilio":"Software & Developer Tools","Shopify":"Software & Developer Tools","Square":"Fintech & Financial Services","Robinhood":"Fintech & Financial Services","Coinbase":"Fintech & Financial Services","Wise":"Fintech & Financial Services","Revolut":"Fintech & Financial Services","Monzo":"Fintech & Financial Services","N26":"Fintech & Financial Services","Plaid":"Fintech & Financial Services","Chime":"Fintech & Financial Services","Brex":"Fintech & Financial Services","Figma":"Software & Developer Tools","Notion":"Software & Developer Tools","Slack":"Software & Developer Tools","Zoom":"Software & Developer Tools","Uber":"Software & Developer Tools","Lyft":"Software & Developer Tools","Airbnb":"Travel & Hospitality","DoorDash":"Consumer & Retail","Instacart":"Consumer & Retail","Snap Inc.":"Big Tech","Twitter":"Big Tech","Pinterest":"Big Tech","Reddit":"Big Tech","LinkedIn":"Big Tech","TikTok":"Big Tech","ByteDance":"Big Tech","Spotify":"Media & Creative","Disney":"Media & Creative","Warner Bros. Discovery":"Media & Creative","Pfizer":"Healthcare & Biotech","Johnson & Johnson":"Healthcare & Biotech","Moderna":"Healthcare & Biotech","nsave":"Fintech & Financial Services","Rhodes Trust":"Startups & Accelerators","Imperial College London":"Startups & Accelerators","University of Oxford":"Startups & Accelerators","Stanford University":"Startups & Accelerators","MIT":"Startups & Accelerators","Harvard University":"Startups & Accelerators","Cambridge University":"Startups & Accelerators","UCL":"Startups & Accelerators","LSE":"Startups & Accelerators","ETH Zurich":"Startups & Accelerators","Caltech":"Startups & Accelerators","Carnegie Mellon University":"Startups & Accelerators","Columbia University":"Startups & Accelerators","Yale University":"Startups & Accelerators","Princeton University":"Startups & Accelerators","Founder Institute":"Startups & Accelerators","500 Global":"Startups & Accelerators","Antler":"Startups & Accelerators","Seedcamp":"Venture Capital & Investment","Atomico":"Venture Capital & Investment","Balderton Capital":"Venture Capital & Investment","Northzone":"Venture Capital & Investment","EQT Ventures":"Venture Capital & Investment","Dawn Capital":"Venture Capital & Investment","Octopus Ventures":"Venture Capital & Investment","LocalGlobe":"Venture Capital & Investment","Passion Capital":"Venture Capital & Investment","Cherry Ventures":"Venture Capital & Investment","Point Nine Capital":"Venture Capital & Investment","Felix Capital":"Venture Capital & Investment","Mosaic Ventures":"Venture Capital & Investment","Air Street Capital":"Venture Capital & Investment","Notion Capital":"Venture Capital & Investment"};

  // Industry keyword fallback (when company not in map)
  const INDUSTRY_KEYWORDS = {
    'AI & Machine Learning': /\b(ai|artificial intelligence|machine learning|deep learning|nlp|computer vision|neural|gpt|llm|ml ops)\b/i,
    'Software & Developer Tools': /\b(software|saas|developer tool|devops|cloud|platform|api|data infrastructure)\b/i,
    'Fintech & Financial Services': /\b(fintech|banking|payment|insurance|trading|crypto|blockchain|defi|web3)\b/i,
    'Healthcare & Biotech': /\b(health|medical|biotech|pharma|genomic|clinical|therapy|diagnostic)\b/i,
    'Climate & Energy': /\b(climate|energy|solar|wind|carbon|sustainability|cleantech|green)\b/i,
    'Robotics, Space & Hardware': /\b(robot|drone|hardware|space|satellite|semiconductor|iot|sensor)\b/i,
    'Consulting & Professional Services': /\b(consult|advisory|professional services|management consult)\b/i,
    'Venture Capital & Investment': /\b(venture|capital|invest|fund|portfolio|angel|private equity)\b/i,
    'Media & Creative': /\b(media|creative|content|entertainment|game|music|film|design agency)\b/i,
    'Consumer & Retail': /\b(consumer|retail|ecommerce|e-commerce|marketplace|brand|d2c|dtc)\b/i,
    'Travel & Hospitality': /\b(travel|hotel|hospitality|tourism|airline|booking)\b/i,
  };

  function classifyIndustry(p) {
    const company = p.c || '';
    if (COMPANY_INDUSTRY_MAP[company]) return COMPANY_INDUSTRY_MAP[company];

    // Try keyword matching on company + position
    const text = (company + ' ' + (p.p || '')).toLowerCase();
    for (const [industry, regex] of Object.entries(INDUSTRY_KEYWORDS)) {
      if (regex.test(text)) return industry;
    }
    return 'Other';
  }

  function parseCSV(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return [];
    // Find the header line (LinkedIn CSVs have notes at the top)
    let headerIdx = 0;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (lines[i].includes('First Name')) { headerIdx = i; break; }
    }
    const headerLine = lines[headerIdx];
    const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const fi = headers.indexOf('First Name');
    const li = headers.indexOf('Last Name');
    const ui = headers.indexOf('URL');
    const ei = headers.indexOf('Email Address');
    const ci = headers.indexOf('Company');
    const pi = headers.indexOf('Position');
    const di = headers.indexOf('Connected On');

    const data = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Handle quoted CSV fields
      const fields = [];
      let current = '';
      let inQuotes = false;
      for (let c = 0; c < line.length; c++) {
        if (line[c] === '"') { inQuotes = !inQuotes; }
        else if (line[c] === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
        else { current += line[c]; }
      }
      fields.push(current.trim());

      const firstName = (fields[fi] || '').trim();
      const lastName = (fields[li] || '').trim();
      if (!firstName && !lastName) continue;

      data.push({
        f: firstName,
        l: lastName,
        u: (fields[ui] || '').trim(),
        e: (fields[ei] || '').trim(),
        c: (fields[ci] || '').trim(),
        p: (fields[pi] || '').trim(),
        d: (fields[di] || '').trim(),
      });
    }
    return data;
  }

  /**
   * Discovery score — weighted ranking of how valuable a contact might be.
   */
  function discoveryScore(p) {
    let score = 0;
    const cat = p._cat;

    // Category base weights
    const pw = {
      'pw-founder': { cat: 'founder_ceo', val: 50 },
      'pw-investor': { cat: 'investor_vc', val: 35 },
      'pw-exec': { cat: 'exec_leader', val: 30 },
      'pw-sales': { cat: 'sales_growth', val: 20 },
      'pw-ops': { cat: 'ops_strategy', val: 15 },
      'pw-eng': { cat: 'product_eng', val: 10 },
    };

    for (const [id, cfg] of Object.entries(pw)) {
      const el = document.getElementById(id);
      if (el && el.checked && cat === cfg.cat) score += cfg.val;
    }

    // Email bonus
    const emailEl = document.getElementById('pw-email');
    if (emailEl && emailEl.checked && p.e) score += 20;

    // Title bonuses
    const title = (p.p || '').toLowerCase();
    if (/\bceo\b/.test(title)) score += 15;
    if (/\bcto\b/.test(title)) score += 12;
    if (/\bfounder\b/.test(title)) score += 10;
    if (/\bpartner\b/.test(title)) score += 8;
    if (/\bdirector\b/.test(title)) score += 5;

    return score;
  }

  return { COMPANY_INDUSTRY_MAP, classifyIndustry, parseCSV, discoveryScore };
})();

// Expose discoveryScore globally for other modules
window.discoveryScore = DataLoader.discoveryScore;
