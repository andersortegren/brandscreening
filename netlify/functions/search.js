// Searches WIPO Global Brand Database for US, EU (EM), SE offices.
// WIPO uses Altcha proof-of-work CAPTCHA for automated requests.
// This function detects the challenge, solves the SHA-256 PoW, and retries.

const crypto = require('crypto');

const WIPO_SEARCH = 'https://branddb.wipo.int/branddb/api/v1/search';
const WIPO_BASE   = 'https://branddb.wipo.int';

const LIVE_KEYWORDS = [
  'registered', 'live', 'pending', 'published', 'filed', 'active',
  'application received', 'under examination', 'opposition', 'accepted',
];

const OFFICES = {
  US: { name: 'United States (USPTO)', verifyUrl: 'https://tmsearch.uspto.gov/search/' },
  EM: { name: 'European Union (EUIPO)', verifyUrl: 'https://euipo.europa.eu/eSearch/#advanced/trademarks' },
  SE: { name: 'Sweden (PRV)',           verifyUrl: 'https://tc.prv.se/VarumarkesDbWeb/?lang=EN' },
};

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  const q = (event.queryStringParameters?.q || '').trim();
  if (!q || q.length < 2) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'Enter a brand name (at least 2 characters).' }) };
  }

  try {
    const docs = await fetchWIPO(q);
    const result = { query: q, offices: {} };

    for (const [code, meta] of Object.entries(OFFICES)) {
      const officeDocs = docs.filter(d =>
        (d.office || d.tmOffice || '').toUpperCase() === code);
      result.offices[code] = { ...meta, ...buildOfficeResult(officeDocs, q) };
    }
    result.offices.SE.note = 'WIPO may not include all Swedish national marks — verify at PRV.';

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch (err) {
    console.error('[search]', err.message);
    return { statusCode: 502, headers: CORS,
      body: JSON.stringify({ error: 'Could not reach the trademark database.', detail: err.message }) };
  }
};

// ---------------------------------------------------------------------------
// WIPO fetch — handles Altcha PoW CAPTCHA transparently
// ---------------------------------------------------------------------------
const BROWSER_HDR = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Origin:  'https://branddb.wipo.int',
  Referer: 'https://branddb.wipo.int/branddb/en/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

async function fetchWIPO(query) {
  const params = new URLSearchParams({ query, office: 'US,EM,SE', type: 'brandName', rows: '100', start: '0' });
  const url = `${WIPO_SEARCH}?${params}`;

  const abort = new AbortController();
  const t = setTimeout(() => abort.abort('timeout'), 25000);

  try {
    // ---- Attempt 1: direct ----
    const r1    = await fetch(url, { signal: abort.signal, headers: BROWSER_HDR });
    const body1 = await r1.text();   // read body ONCE — content-type header is unreliable
    const cookieStr = extractSetCookie(r1);

    console.log('[wipo] status:', r1.status, '| ct:', r1.headers.get('content-type'), '| body[0..30]:', body1.slice(0, 30));

    // Detect HTML by body content, not Content-Type (WIPO omits it for CAPTCHA pages)
    const isHtml = body1.trimStart().startsWith('<');

    if (!isHtml) {
      if (!r1.ok) throw new Error(`WIPO HTTP ${r1.status}: ${body1.slice(0, 200)}`);
      try { return JSON.parse(body1)?.response?.docs || []; }
      catch { throw new Error(`Non-JSON (${r1.status}): ${body1.slice(0, 300)}`); }
    }

    // ---- CAPTCHA page detected — solve Altcha PoW ----
    const html = body1;

    // Find challenge URL in the HTML
    const challengeUrl = findChallengeUrl(html);
    console.log('[altcha] challenge URL:', challengeUrl);

    // Fetch the challenge JSON
    const cRes = await fetch(challengeUrl, { headers: { ...BROWSER_HDR, Cookie: cookieStr } });
    if (!cRes.ok) throw new Error(`Challenge fetch failed: HTTP ${cRes.status}`);
    const challenge = await cRes.json();
    console.log('[altcha] challenge:', JSON.stringify(challenge));

    // Solve proof-of-work
    const solution = solveAltcha(challenge);
    const token = Buffer.from(JSON.stringify(solution)).toString('base64');
    console.log(`[altcha] solved in ${solution.number} iterations`);

    // ---- Attempt 2: with solution ----
    const r2    = await fetch(url, {
      signal: abort.signal,
      headers: { ...BROWSER_HDR, Authorization: `Altcha ${token}`, Cookie: cookieStr },
    });
    const body2 = await r2.text();
    console.log('[wipo] attempt2 status:', r2.status, '| body[0..30]:', body2.slice(0, 30));

    if (body2.trimStart().startsWith('<')) {
      throw new Error('Still HTML after CAPTCHA solve: ' + body2.slice(0, 300));
    }
    if (!r2.ok) throw new Error(`WIPO HTTP ${r2.status}: ${body2.slice(0, 200)}`);
    try { return JSON.parse(body2)?.response?.docs || []; }
    catch { throw new Error(`Non-JSON after solve (${r2.status}): ${body2.slice(0, 300)}`); }

  } finally {
    clearTimeout(t);
  }
}

function findChallengeUrl(html) {
  // <altcha-widget challengeurl="/path"> or data variants
  const m = html.match(/challenge(?:url|Url|-url)=["']([^"']+)["']/i) ||
            html.match(/data-challenge(?:url|-url)=["']([^"']+)["']/i);
  if (!m) throw new Error('No Altcha challenge URL in CAPTCHA page. HTML: ' + html.slice(0, 400));
  const u = m[1];
  return u.startsWith('http') ? u : WIPO_BASE + u;
}

// SHA-256 brute-force — typically solves < 50ms (n < 50 000)
function solveAltcha({ algorithm = 'SHA-256', challenge, salt, signature, maxnumber = 1000000 }) {
  if (!challenge || !salt) throw new Error('Invalid Altcha challenge: ' + JSON.stringify({ challenge, salt }));
  for (let n = 0; n <= maxnumber; n++) {
    const hash = crypto.createHash('sha256').update(`${salt}${n}`).digest('hex');
    if (hash === challenge) return { algorithm, challenge, number: n, salt, signature };
  }
  throw new Error(`Altcha unsolvable within ${maxnumber} iterations`);
}

function extractSetCookie(res) {
  const raw = res.headers.get('set-cookie') || '';
  if (!raw) return '';
  return raw.split(/,(?=[^ ][^=]+=)/).map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function parseWIPOJson(res) {
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`WIPO HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Non-JSON (${res.status}): ${text.slice(0, 300)}`); }
  return data?.response?.docs || [];
}

// ---------------------------------------------------------------------------
// Risk assessment
// ---------------------------------------------------------------------------
function buildOfficeResult(docs, query) {
  const q = query.toLowerCase().trim();

  const marks = docs.map(d => ({
    name:       pick(d, ['wordMark','tmName','brandName','markVerbal','markText','mark']),
    holder:     pickArr(d, ['holderName','holders','applicantName','applicants']),
    status:     pick(d, ['tmStatus','statusCode','status','statusLabel']),
    appNumber:  pick(d, ['applicationNumber','appNumber','appNum','tmNumber']),
    filingDate: fmtDate(pick(d, ['applicationDate','filingDate','appDate'])),
    classes:    pickArr(d, ['niceClass','niceClasses','goodsAndServices','classes']),
    office:     d.office || d.tmOffice || '',
  }));

  const live = marks.filter(m => LIVE_KEYWORDS.some(k => m.status.toLowerCase().includes(k)));
  const exact = live.some(m => m.name.toLowerCase() === q);

  return {
    risk: exact ? 'red' : live.length > 0 ? 'yellow' : 'green',
    totalMatches: docs.length,
    liveCount: live.length,
    marks,
  };
}

function pick(o, keys) {
  for (const k of keys) if (o[k] != null) { const v = o[k]; return Array.isArray(v) ? v.join('; ') : String(v); }
  return '';
}
function pickArr(o, keys) {
  for (const k of keys) if (o[k] != null) { const v = o[k]; return Array.isArray(v) ? v.join(', ') : String(v); }
  return '';
}
function fmtDate(r) {
  if (!r) return '';
  const s = String(r).replace(/-/g, '');
  return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : r;
}
