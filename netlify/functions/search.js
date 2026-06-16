// Searches WIPO Global Brand Database for US, EU (EM), SE offices.
// WIPO uses an Altcha proof-of-work CAPTCHA gateway.
// Flow: prewarm session → API call → if CAPTCHA, solve PoW → POST to verify endpoint → retry API with cookie.

const crypto = require('crypto');

const WIPO_BASE   = 'https://branddb.wipo.int';
const WIPO_SEARCH = `${WIPO_BASE}/branddb/api/v1/search`;
const WIPO_HOME   = `${WIPO_BASE}/branddb/en/`;

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
      const officeDocs = docs.filter(d => (d.office || d.tmOffice || '').toUpperCase() === code);
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
// WIPO fetch with Altcha CAPTCHA gateway handling
//
// Real browser flow:
//  1. Visit page → CAPTCHA challenge page returned (no cookie yet)
//  2. Widget finds challengeurl, fetches challenge JSON
//  3. Widget solves SHA-256 PoW
//  4. Widget POSTs solution to a verify endpoint → receives session cookie
//  5. Original request retried WITH that cookie → real JSON returned
// ---------------------------------------------------------------------------

const BROWSER_HDR = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Origin:  WIPO_BASE,
  Referer: WIPO_HOME,
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

async function fetchWIPO(query) {
  const params  = new URLSearchParams({ query, office: 'US,EM,SE', type: 'brandName', rows: '100', start: '0' });
  const apiUrl  = `${WIPO_SEARCH}?${params}`;
  const abort   = new AbortController();
  const timer   = setTimeout(() => abort.abort('timeout'), 28000);

  try {
    // Step 1 — prewarm: visit homepage to pick up any initial session cookies
    const warmCookies = await prewarmSession();
    console.log('[warm] cookies:', warmCookies.slice(0, 80));

    // Step 2 — first API attempt (may get CAPTCHA page)
    const r1    = await fetch(apiUrl, { signal: abort.signal, headers: cookieHdr(warmCookies) });
    const body1 = await r1.text();
    const isHtml1 = body1.trimStart().startsWith('<');
    console.log('[api1] status:', r1.status, 'html?', isHtml1, 'ct:', r1.headers.get('content-type'));

    if (!isHtml1) return parseDocsJson(r1.status, body1);

    // Step 3 — CAPTCHA detected: extract URLs from challenge page HTML
    const caps1 = mergeCookes(warmCookies, getCookies(r1));

    // Log the full HTML so we can see the complete JS/form structure
    console.log('[captcha] HTML (0-2000):', body1.slice(0, 2000));

    // Extract the UUID embedded in the challenge page JavaScript
    // Format: let uuid = "timestamp|token";
    const uuidMatch = body1.match(/let\s+uuid\s*=\s*["']([^"']+)["']/);
    const uuid = uuidMatch ? uuidMatch[1] : null;
    console.log('[captcha] uuid:', uuid);

    const challengeUrl = extractChallengeUrl(body1, uuid);
    console.log('[altcha] challengeUrl:', challengeUrl);

    // Step 4 — fetch the challenge JSON
    const cRes = await fetch(challengeUrl, { headers: cookieHdr(caps1) });
    if (!cRes.ok) throw new Error(`Challenge JSON fetch: HTTP ${cRes.status} from ${challengeUrl}`);
    const challenge = await cRes.json();
    const caps2 = mergeCookes(caps1, getCookies(cRes));
    console.log('[altcha] challenge:', JSON.stringify(challenge));

    // Step 5 — solve SHA-256 proof of work
    const solution = solveAltcha(challenge);
    const token    = Buffer.from(JSON.stringify(solution)).toString('base64');
    console.log('[altcha] solved: n =', solution.number);

    // Step 6a — try: append solution as query param to the API URL (common in custom Altcha gateways)
    const apiUrlWithToken = apiUrl + `&altcha=${encodeURIComponent(token)}` + (uuid ? `&uuid=${encodeURIComponent(uuid)}` : '');
    const r2a    = await fetch(apiUrlWithToken, { signal: abort.signal, headers: cookieHdr(caps2) });
    const body2a = await r2a.text();
    const isHtml2a = body2a.trimStart().startsWith('<');
    console.log('[api2a] status:', r2a.status, 'html?', isHtml2a);

    if (!isHtml2a) return parseDocsJson(r2a.status, body2a);

    // Step 6b — try: POST solution to verify endpoint → get session cookie, then retry
    const verifyUrl = extractVerifyUrl(body1, uuid);
    console.log('[altcha] verifyUrl:', verifyUrl);

    const vRes = await fetch(verifyUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...cookieHdr(caps2),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml',
      },
      body: new URLSearchParams({ altcha: token, ...(uuid ? { uuid } : {}) }).toString(),
    });
    const caps3 = mergeCookes(caps2, getCookies(vRes));
    console.log('[verify] status:', vRes.status, 'location:', vRes.headers.get('location'), 'cookies:', caps3.slice(0, 150));

    // Step 7 — retry original API with verified session cookie
    const r2    = await fetch(apiUrl, { signal: abort.signal, headers: cookieHdr(caps3) });
    const body2 = await r2.text();
    const isHtml2 = body2.trimStart().startsWith('<');
    console.log('[api2] status:', r2.status, 'html?', isHtml2);

    if (isHtml2) throw new Error(`Still HTML after all attempts. HTML (0-1500): ${body2.slice(0, 1500)}`);
    return parseDocsJson(r2.status, body2);

  } finally {
    clearTimeout(timer);
  }
}

async function prewarmSession() {
  try {
    const r = await fetch(WIPO_HOME, {
      headers: { ...BROWSER_HDR, Accept: 'text/html,application/xhtml+xml' },
    });
    return getCookies(r);
  } catch (e) {
    console.log('[prewarm] failed:', e.message);
    return '';
  }
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

function extractChallengeUrl(html, uuid) {
  // 1. Look for challengeurl attribute on the widget element
  const m = html.match(/challenge(?:url|Url|-url)=["']([^"']+)["']/i) ||
            html.match(/data-challenge(?:-url)?=["']([^"']+)["']/i);
  if (m) {
    const u = m[1];
    return u.startsWith('http') ? u : WIPO_BASE + u;
  }

  // 2. Look for challenge URL in JS (e.g. fetch('/branddb/altcha?uuid=...'))
  const jsUrl = html.match(/fetch\(["']([^"']*altcha[^"']*)["']/i);
  if (jsUrl) {
    const u = jsUrl[1];
    return u.startsWith('http') ? u : WIPO_BASE + u;
  }

  // 3. Construct from UUID using known WIPO path patterns
  if (uuid) {
    return `${WIPO_BASE}/branddb/altcha?uuid=${encodeURIComponent(uuid)}`;
  }

  throw new Error('No challenge URL found. HTML: ' + html.slice(0, 600));
}

function extractVerifyUrl(html, uuid) {
  // 1. Explicit verifyurl attribute
  const va = html.match(/verify(?:url|Url|-url)=["']([^"']+)["']/i);
  if (va) return va[1].startsWith('http') ? va[1] : WIPO_BASE + va[1];

  // 2. Form action
  const fa = html.match(/<form[^>]+action=["']([^"'#?][^"']*?)["']/i);
  if (fa) return fa[1].startsWith('http') ? fa[1] : WIPO_BASE + fa[1];

  // 3. JS fetch/post URL in the page
  const jsPost = html.match(/(?:post|submit)\s*\(\s*["']([^"']+)["']/i);
  if (jsPost) {
    const u = jsPost[1];
    return u.startsWith('http') ? u : WIPO_BASE + u;
  }

  // 4. Derive from challenge path: /altcha → /altcha-verify
  if (uuid) return `${WIPO_BASE}/branddb/altcha-verify`;

  return `${WIPO_BASE}/altcha-verify`;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function getCookies(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return '';
  return raw.split(/,(?=[^ ;][^=]*=)/).map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

function mergeCookes(a, b) {
  const parts = [a, b].filter(Boolean);
  return parts.join('; ').replace(/;\s*;/g, ';').trim();
}

function cookieHdr(cookieStr) {
  return cookieStr ? { ...BROWSER_HDR, Cookie: cookieStr } : BROWSER_HDR;
}

// ---------------------------------------------------------------------------
// Altcha SHA-256 proof-of-work solver
// ---------------------------------------------------------------------------

function solveAltcha({ algorithm = 'SHA-256', challenge, salt, signature, maxnumber = 1000000 }) {
  if (!challenge || !salt) throw new Error('Invalid challenge: ' + JSON.stringify({ challenge, salt }));
  for (let n = 0; n <= maxnumber; n++) {
    const hash = crypto.createHash('sha256').update(`${salt}${n}`).digest('hex');
    if (hash === challenge) return { algorithm, challenge, number: n, salt, signature };
  }
  throw new Error(`Altcha unsolvable within ${maxnumber} iterations`);
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

function parseDocsJson(status, text) {
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text)?.response?.docs || []; }
  catch { throw new Error(`Non-JSON (${status}): ${text.slice(0, 300)}`); }
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

  const live  = marks.filter(m => LIVE_KEYWORDS.some(k => m.status.toLowerCase().includes(k)));
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
