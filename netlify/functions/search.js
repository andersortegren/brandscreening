// Brand Name Check — Trademark search across US (USPTO via MarkerAPI), EU (EUIPO), and Sweden (PRV).
// Requires env vars: MARKER_USERNAME + MARKER_PASSWORD (USPTO) and EUIPO_CLIENT_ID + EUIPO_CLIENT_SECRET (EU).
// Set EUIPO_SANDBOX=false to use production EUIPO API (default: sandbox).

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

// EUIPO OAuth2 token cache — persists across warm function invocations
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

// ─── USPTO via MarkerAPI ───────────────────────────────────────────────────────

async function fetchUSPTO(query) {
  const username = process.env.MARKER_USERNAME;
  const password = process.env.MARKER_PASSWORD;

  if (!username || !password) {
    throw new Error(
      'USPTO not configured — add MARKER_USERNAME + MARKER_PASSWORD in Netlify env vars ' +
      '(free tier at markerapi.com)'
    );
  }

  const url = `https://markerapi.com/api/v2/trademarks/trademark/${encodeURIComponent(query)}` +
              `/status/all/start/1/username/${encodeURIComponent(username)}` +
              `/password/${encodeURIComponent(password)}`;

  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!r.ok) throw new Error(`MarkerAPI HTTP ${r.status}`);

  const data = await r.json();
  console.log('[uspto] count:', data.count, 'keys:', Object.keys(data).join(','));
  if (data.trademarks?.[0]) console.log('[uspto] first keys:', Object.keys(data.trademarks[0]).join(','));

  return (data.trademarks || []).map(t => ({
    name:       t.wordmark || t.keyword || '',
    holder:     typeof t.owner === 'object' ? (t.owner?.name || '') : (t.owner || ''),
    status:     t.statusdescription || t.status || t.statuscode || '',
    appNumber:  t.serialnumber || t.registrationnumber || '',
    filingDate: fmtDate(t.filingdate || t.applicationdate || ''),
    classes:    arrToStr(t.code || t.niceclass || ''),
    office:     'US',
  }));
}

// ─── EU via EUIPO OAuth2 API ───────────────────────────────────────────────────

async function getEUIPOToken() {
  if (euipoToken && Date.now() < euipoTokenExpires) return euipoToken;

  const clientId     = process.env.EUIPO_CLIENT_ID;
  const clientSecret = process.env.EUIPO_CLIENT_SECRET;
  const sandbox      = process.env.EUIPO_SANDBOX !== 'false'; // default: sandbox

  if (!clientId || !clientSecret) {
    throw new Error(
      'EUIPO not configured — register at dev.euipo.europa.eu and add ' +
      'EUIPO_CLIENT_ID + EUIPO_CLIENT_SECRET in Netlify env vars'
    );
  }

  const tokenUrl = sandbox
    ? 'https://auth-sandbox.euipo.europa.eu/oidc/accessToken'
    : 'https://auth.euipo.europa.eu/oidc/accessToken';

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
      'EUIPO not configured — register at dev.euipo.europa.eu and add ' +
      'EUIPO_CLIENT_ID + EUIPO_CLIENT_SECRET in Netlify env vars'
    );
  }

  const sandbox = process.env.EUIPO_SANDBOX !== 'false';
  const base    = sandbox
    ? 'https://api-sandbox.euipo.europa.eu/trademark-search'
    : 'https://api.euipo.europa.eu/trademark-search';

  const token = await getEUIPOToken();

  // Try both common query param names — log response to discover correct one
  const params = new URLSearchParams({
    wordmark: query,
    page:     '0',
    size:     '50',
  });

  const url = `${base}/trademarks?${params}`;
  console.log('[euipo] GET', url);

  const r = await fetch(url, {
    headers: {
      Authorization:    `Bearer ${token}`,
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

// ─── Sweden (PRV) ─────────────────────────────────────────────────────────────

async function fetchPRV(query) {
  return [];
}

// ─── Risk assessment ──────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function arrToStr(v) {
  if (Array.isArray(v)) return v.join(', ');
  return v ? String(v) : '';
}

function fmtDate(r) {
  if (!r) return '';
  const s = String(r).replace(/-/g, '');
  return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : String(r);
}
