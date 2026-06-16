// Brand Name Check - Trademark search across US (USPTO via Parse.bot), EU (EUIPO), and Sweden (PRV).
// Env vars needed:
//   PARSE_API_KEY       - free at parse.bot (USPTO data)
//   EUIPO_CLIENT_ID     - from dev.euipo.europa.eu app registration
//   EUIPO_CLIENT_SECRET - from dev.euipo.europa.eu app registration
//   EUIPO_SANDBOX       - set to "true" to use sandbox, omit or set "false" for production

const LIVE_KEYWORDS = [
  'registered', 'live', 'pending', 'published', 'filed', 'active',
  'application received', 'under examination', 'opposition', 'accepted',
];

const OFFICES = {
  US: { name: 'United States (USPTO)', verifyUrl: 'https://tmsearch.uspto.gov/' },
  EM: { name: 'European Union (EUIPO)', verifyUrl: 'https://euipo.europa.eu/eSearch/#advanced/trademarks' },
  SE: { name: 'Sweden (PRV)',           verifyUrl: 'https://tc.prv.se/VarumarkesDbWeb/?lang=EN' },
};

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// EUIPO OAuth2 token cache - persists across warm function invocations
let euipoToken = null;
let euipoTokenExpires = 0;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  const q = (event.queryStringParameters?.q || '').trim();
  if (!q || q.length < 2) {
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'Enter a brand name (at least 2 characters).' }),
    };
  }

  const [euResult, usResult, seResult] = await Promise.allSettled([
    fetchEUIPO(q),
    fetchUSPTO(q),
    fetchPRV(q),
  ]);

  const result = { query: q, offices: {} };

  for (const [code, meta] of Object.entries(OFFICES)) {
    const settled = { US: usResult, EM: euResult, SE: seResult }[code];
    if (settled.status === 'fulfilled') {
      result.offices[code] = { ...meta, ...buildOfficeResult(settled.value, q) };
    } else {
      console.error(`[${code}] failed:`, settled.reason?.message);
      result.offices[code] = {
        ...meta,
        risk: 'unknown',
        totalMatches: 0,
        liveCount: 0,
        marks: [],
        error: settled.reason?.message || 'Search failed',
      };
    }
  }
  result.offices.SE.note = 'Swedish PRV national marks require direct verification at PRV.';

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};

// USPTO via Parse.bot (wraps tmsearch.uspto.gov) - free tier 100 req/month
async function fetchUSPTO(query) {
  const apiKey = process.env.PARSE_API_KEY;
  if (!apiKey) {
    throw new Error('USPTO not configured - add PARSE_API_KEY (free at parse.bot)');
  }

  const url = 'https://api.parse.bot/scraper/82426fc4-aff3-4504-aa52-1dea89a26c73/search_trademarks' +
              `?limit=50&query=${encodeURIComponent(query)}&offset=0`;

  let body;
  try {
    const r = await fetch(url, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json', 'User-Agent': UA },
    });
    body = await r.text();
    console.log('[uspto] status:', r.status, 'body[:200]:', body.slice(0, 200));
    if (!r.ok) throw new Error(`Parse.bot HTTP ${r.status}: ${body.slice(0, 120)}`);
  } catch (e) {
    throw new Error(`USPTO fetch error: ${e.message}`);
  }

  const wrapper = JSON.parse(body);
  const data    = wrapper.data || wrapper;
  console.log('[uspto] total:', data.total, 'returned:', data.trademarks?.length);

  return (data.trademarks || []).map(t => ({
    name:       t.wordmark || '',
    holder:     Array.isArray(t.owner_name) ? (t.owner_name[0] || '') : (t.owner_name || ''),
    status:     t.status || '',
    appNumber:  t.serial_number || t.registration_id || '',
    filingDate: fmtDate(t.filed_date || t.registration_date || ''),
    classes:    arrToStr(t.international_class || []),
    office:     'US',
  }));
}

// EU via EUIPO OAuth2 API (production portal: dev.euipo.europa.eu)
async function getEUIPOToken() {
  if (euipoToken && Date.now() < euipoTokenExpires) return euipoToken;

  const clientId     = process.env.EUIPO_CLIENT_ID;
  const clientSecret = process.env.EUIPO_CLIENT_SECRET;
  const sandbox      = process.env.EUIPO_SANDBOX === 'true'; // default: production

  if (!clientId || !clientSecret) {
    throw new Error(
      'EUIPO not configured - register at dev.euipo.europa.eu, add ' +
      'EUIPO_CLIENT_ID + EUIPO_CLIENT_SECRET in Netlify env vars'
    );
  }

  const tokenUrl = sandbox
    ? 'https://auth-sandbox.euipo.europa.eu/oidc/accessToken'
    : 'https://auth.euipo.europa.eu/oidc/accessToken';

  console.log('[euipo] fetching token from', sandbox ? 'sandbox' : 'production');

  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'client_credentials',
    scope:         'uid',
  });

  const r = await fetch(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body:    body.toString(),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`EUIPO token error ${r.status}: ${err.slice(0, 120)}`);
  }

  const data        = await r.json();
  euipoToken        = data.access_token;
  euipoTokenExpires = Date.now() + Math.max(0, (data.expires_in || 28800) - 300) * 1000;
  console.log('[euipo] token obtained, expires_in:', data.expires_in);
  return euipoToken;
}

async function fetchEUIPO(query) {
  const clientId = process.env.EUIPO_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'EUIPO not configured - register at dev.euipo.europa.eu, add ' +
      'EUIPO_CLIENT_ID + EUIPO_CLIENT_SECRET in Netlify env vars'
    );
  }

  const sandbox = process.env.EUIPO_SANDBOX === 'true';
  const base    = sandbox
    ? 'https://api-sandbox.euipo.europa.eu/trademark-search'
    : 'https://api.euipo.europa.eu/trademark-search';

  const token = await getEUIPOToken();

  const params = new URLSearchParams({ wordmark: query, page: '0', size: '50' });
  const url    = `${base}/trademarks?${params}`;
  console.log('[euipo] GET', url);

  const r = await fetch(url, {
    headers: {
      Authorization:     `Bearer ${token}`,
      'X-IBM-Client-Id': clientId,
      Accept:            'application/json',
      'User-Agent':      UA,
    },
  });

  const body = await r.text();
  console.log('[euipo] status:', r.status, 'body[:200]:', body.slice(0, 200));

  if (!r.ok) throw new Error(`EUIPO search HTTP ${r.status}: ${body.slice(0, 120)}`);

  const data = JSON.parse(body);
  return parseEUIPO(data);
}

function parseEUIPO(data) {
  console.log('[euipo] response keys:', Object.keys(data).join(','));
  const items = data.trademarks || data.content || data.results || data.items || [];
  if (items[0]) console.log('[euipo] first item keys:', Object.keys(items[0]).join(','));
  return items.map(t => ({
    name:       t.wordMark || t.tmName || t.trademarkName || t.wordmark || t.name || '',
    holder:     t.holderName || t.ownerName || t.applicantName ||
                (Array.isArray(t.holders) ? t.holders[0]?.name || t.holders[0] : '') ||
                (Array.isArray(t.owners)  ? t.owners[0]?.name  : '') || '',
    status:     t.tmStatus || t.status || t.statusCode || t.statusDescription || '',
    appNumber:  t.applicationNumber || t.appNumber || t.trademarkId || '',
    filingDate: fmtDate(t.applicationDate || t.filingDate || ''),
    classes:    arrToStr(t.niceClasses || t.niceClass || t.classes || []),
    office:     'EM',
  }));
}

// Sweden (PRV) - scrapes tc.prv.se JSF search form
async function fetchPRV(query) {
  const BASE    = 'https://tc.prv.se/VarumarkesDbWeb';
  const SEARCH  = `${BASE}/faces/searchBasic.xhtml?lang=EN`;
  const headers = {
    'User-Agent': UA,
    Accept:       'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // Step 1: GET search page to collect ViewState + session cookie + form field names
  const getRes = await fetch(SEARCH, { headers });
  if (!getRes.ok) throw new Error(`PRV GET ${getRes.status}`);

  const html    = await getRes.text();
  const cookies = getRes.headers.get('set-cookie') || '';
  const cookie  = cookies.split(';')[0];  // grab first cookie (JSESSIONID)

  // Extract ViewState
  const vsMatch = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
  if (!vsMatch) {
    console.log('[prv] no ViewState found — page head:', html.slice(0, 300));
    throw new Error('PRV: could not find ViewState in search form');
  }
  const viewState = vsMatch[1];

  // Find the form id (e.g. <form id="j_idt42" ...>)
  const formIdMatch = html.match(/<form[^>]+id="([^"]+)"[^>]*method="post"/i);
  const formId      = formIdMatch ? formIdMatch[1] : '';

  // Find the text input for word mark search (look for input with type=text near "word" or "mark")
  // JSF field names follow pattern "formId:fieldId"
  const inputMatches = [...html.matchAll(/<input[^>]+type="text"[^>]*name="([^"]+)"/gi)];
  console.log('[prv] text inputs:', inputMatches.map(m => m[1]).join(', '));

  // Prefer a field whose name contains "word" or "mark" or "name"; fall back to first text input
  let searchField = inputMatches.find(m =>
    /word|mark|name|term|query|search/i.test(m[1])
  )?.[1] || inputMatches[0]?.[1];

  if (!searchField) {
    // Also try textarea
    const taMatch = html.match(/<textarea[^>]+name="([^"]+)"/i);
    searchField   = taMatch?.[1];
  }

  console.log('[prv] ViewState found, formId:', formId, 'searchField:', searchField);

  if (!searchField) throw new Error('PRV: could not identify search input field');

  // Step 2: POST the search
  const postBody = new URLSearchParams({
    [formId]:                            formId,
    [searchField]:                       query,
    'javax.faces.ViewState':             viewState,
    'javax.faces.partial.ajax':          'false',
  });

  // Add submit button (JSF often requires the button name in the POST)
  const btnMatch = html.match(/<input[^>]+type="submit"[^>]*name="([^"]+)"/i)
                || html.match(/<button[^>]+name="([^"]+)"[^>]*type="submit"/i);
  if (btnMatch) postBody.set(btnMatch[1], btnMatch[1]);

  const postRes = await fetch(SEARCH, {
    method:  'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie:         cookie,
      Referer:        SEARCH,
    },
    body: postBody.toString(),
  });

  const resultHtml = await postRes.text();
  console.log('[prv] POST status:', postRes.status, 'result length:', resultHtml.length);
  console.log('[prv] result snippet:', resultHtml.slice(0, 400));

  return parsePRV(resultHtml, query);
}

function parsePRV(html, query) {
  // PRV results are typically in a table; extract rows
  const marks = [];
  // Match table rows with trademark data
  const rowMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const row of rowMatches) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 2) continue;

    // Heuristic: row contains something matching the query or looks like a trademark record
    const rowText = cells.join(' ').toLowerCase();
    if (!rowText.includes(query.toLowerCase()) && !rowText.match(/\d{4}/)) continue;

    // Try to identify columns: mark name, holder, status, app number, classes
    // PRV table order is typically: appNumber, markName, holder, status, classes
    const appNum = cells.find(c => /^\d{6,}$/.test(c.trim())) || '';
    const name   = cells.find(c => c.toUpperCase() === c && c.length > 1 && !/^\d+$/.test(c)) || cells[1] || '';
    const status = cells.find(c => /registr|ansökan|cancelled|pending|valid|förfall/i.test(c)) || '';

    if (!name) continue;
    marks.push({
      name,
      holder:     '',
      status:     status || 'unknown',
      appNumber:  appNum,
      filingDate: '',
      classes:    '',
      office:     'SE',
    });
  }

  console.log('[prv] parsed marks:', marks.length);
  return marks;
}

// Risk assessment
function buildOfficeResult(marks, query) {
  const q     = query.toLowerCase().trim();
  const live  = marks.filter(m => LIVE_KEYWORDS.some(k => m.status.toLowerCase().includes(k)));
  const exact = live.some(m => m.name.toLowerCase() === q);
  return {
    risk:         exact ? 'red' : live.length > 0 ? 'yellow' : 'green',
    totalMatches: marks.length,
    liveCount:    live.length,
    marks,
  };
}

function arrToStr(v) {
  if (Array.isArray(v)) return v.join(', ');
  return v ? String(v) : '';
}

function fmtDate(r) {
  if (!r) return '';
  // Handle ISO datetime strings like "2018-03-30T00:00:00"
  const s = String(r).split('T')[0].replace(/-/g, '');
  return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : String(r).split('T')[0];
}
