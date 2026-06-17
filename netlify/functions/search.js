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

// EUIPO uses IBM API Connect — auth via X-IBM-Client-Id + X-IBM-Client-Secret headers directly.
// No OAuth2 token fetch needed; the auth.euipo.europa.eu OIDC endpoint is blocked from Lambda.

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
  result.offices.SE.note = `No automated API available — verify at search.prv.se`;
  // Make the verifyUrl a pre-searched link on the new PRV database
  result.offices.SE.verifyUrl = `https://search.prv.se/#/trademark`;

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

// EU via EUIPO IBM API Connect (production portal: dev.euipo.europa.eu)
// Auth: X-IBM-Client-Id + X-IBM-Client-Secret headers — no OAuth2 token fetch.
async function fetchEUIPO(query) {
  const clientId     = process.env.EUIPO_CLIENT_ID;
  const clientSecret = process.env.EUIPO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'EUIPO not configured - register at dev.euipo.europa.eu, add ' +
      'EUIPO_CLIENT_ID + EUIPO_CLIENT_SECRET in Netlify env vars'
    );
  }

  const sandbox = process.env.EUIPO_SANDBOX === 'true';
  const base    = sandbox
    ? 'https://api-sandbox.euipo.europa.eu/trademark-search'
    : 'https://api.euipo.europa.eu/trademark-search';

  const params = new URLSearchParams({ wordMark: query, page: '0', size: '50' });
  const url    = `${base}/trademarks?${params}`;
  console.log('[euipo] GET', url);

  const r = await fetch(url, {
    headers: {
      'X-IBM-Client-Id':     clientId,
      'X-IBM-Client-Secret': clientSecret,
      Accept:                'application/json',
      'User-Agent':          UA,
    },
  });

  const body = await r.text();
  console.log('[euipo] status:', r.status, 'body[:1000]:', body.slice(0, 1000));

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

// Sweden (PRV) - no accessible API exists for Lambda/serverless environments.
// Both the old tc.prv.se JSF interface (retired Jan 2026) and TMview (tmdn.org) block AWS IPs.
// PRV's new search.prv.se is a client-rendered SPA with no public REST API.
// WIPO Brand DB prohibits automated querying in its terms of use.
// Result: SE always returns unknown; user is directed to search.prv.se to verify manually.
async function fetchPRV(query) {
  throw new Error('Swedish PRV search unavailable in automated mode — verify at search.prv.se');
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
