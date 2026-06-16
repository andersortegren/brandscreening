// Brand Name Check - Trademark search across US (USPTO via Parse.bot), EU (EUIPO), and Sweden (PRV).
// Env vars needed:
//   PARSE_API_KEY       - free at parse.bot (USPTO data)
//   EUIPO_CLIENT_ID     - from dev.euipo.europa.eu app registration
//   EUIPO_CLIENT_SECRET - from dev.euipo.europa.eu app registration
//   EUIPO_SANDBOX       - set to "true" to use sandbox, omit or set "false" for production

const LIVE_KEYWORDS = [
  'registered', 'live', 'pending', 'published', 'filed', 'active',
  'application received', 'under examination', 'opposition', 'accepted',
  // Swedish PRV status terms (via TMview)
  'registrerat', 'ingivet', 'ansökt', 'invändning', 'publicerat',
];

const OFFICES = {
  US: { name: 'United States (USPTO)', verifyUrl: 'https://tmsearch.uspto.gov/' },
  EM: { name: 'European Union (EUIPO)', verifyUrl: 'https://euipo.europa.eu/eSearch/#advanced/trademarks' },
  SE: { name: 'Sweden (PRV)',           verifyUrl: 'https://search.prv.se/#/trademark' },
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

// Sweden (PRV) via TMview - searches SE office marks at tmdn.org/tmview
// TMview aggregates all European national trademark offices including PRV Sweden.
async function fetchPRV(query) {
  // TMview jqGrid JSON endpoint - filters to SE (PRV) office only
  const url = 'https://www.tmdn.org/tmview/search-tmv?' + new URLSearchParams({
    rows:                  '50',
    page:                  '1',
    sidx:                  'tm',
    sord:                  'asc',
    q:                     `tm:${query}`,
    fq:                    '[]',
    pageSize:              '50',
    providerList:          'SE',
    selectedRowRefNumber:  'null',
    expandedOffices:       'null',
  });

  console.log('[prv/tmview] GET', url);
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept:       'application/json, text/javascript, */*',
      Referer:      'https://www.tmdn.org/tmview/welcome',
    },
  });

  const body = await r.text();
  console.log('[prv/tmview] status:', r.status, 'body[:300]:', body.slice(0, 300));

  if (!r.ok) throw new Error(`TMview HTTP ${r.status}: ${body.slice(0, 120)}`);
  if (!body || body.trim() === '') throw new Error('TMview returned empty response');

  const data = JSON.parse(body);
  return parseTMview(data, query);
}

function parseTMview(data, query) {
  // TMview returns jqGrid format: { total, page, records, rows: [{ id, cell: [...] }] }
  // cell order (approx): ST13/ref, office, wordmark, status, appDate, expiryDate, niceClasses, applicant
  console.log('[prv/tmview] total:', data.total, 'records:', data.records, 'rows:', data.rows?.length);

  const stripHtml = s => String(s || '').replace(/<[^>]+>/g, '').trim();

  const rows = data.rows || [];
  return rows.map(row => {
    const c = (row.cell || []).map(stripHtml);
    // TMview cell order (typical): [ST13/ref, office, wordmark, status, appDate, expiryDate, niceClasses, applicant]
    const name      = c[2] || c[1] || row.id || '';
    const status    = c[3] || '';
    const appDate   = c[4] || '';
    const classes   = c[6] || '';
    const holder    = c[7] || '';
    return {
      name:       name,
      holder:     holder,
      status:     status,
      appNumber:  String(row.id || '').split('-').pop() || '',
      filingDate: fmtDate(appDate),
      classes:    classes,
      office:     'SE',
    };
  }).filter(m => m.name);
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
