// Brand Name Check — Edge Function (Deno/Cloudflare)
// Runs on Cloudflare's network so EUIPO's auth.euipo.europa.eu is reachable.
// (AWS Lambda IPs are blocked by EUIPO's auth server; Cloudflare IPs are not.)
//
// Env vars (same as the Lambda function):
//   PARSE_API_KEY       - free at parse.bot (USPTO data)
//   EUIPO_CLIENT_ID     - API Key from dev.euipo.europa.eu app
//   EUIPO_CLIENT_SECRET - API Secret from dev.euipo.europa.eu app

const LIVE_KEYWORDS = [
  'registered', 'live', 'pending', 'published', 'filed', 'active',
  'application received', 'under examination', 'opposition', 'accepted',
  'received', 'under_examination', 'application_published', 'registration_pending',
  'opposition_pending', 'appealed', 'cancellation_pending', 'acceptance_pending',
  'start_of_opposition_period', 'appealable',
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

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const q   = (url.searchParams.get('q') || '').trim();

  if (!q || q.length < 2) {
    return new Response(
      JSON.stringify({ error: 'Enter a brand name (at least 2 characters).' }),
      { status: 400, headers: CORS },
    );
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
        liveCount:    0,
        marks:        [],
        error:        settled.reason?.message || 'Search failed',
      };
    }
  }

  result.offices.SE.note      = 'No automated API available — verify at search.prv.se';
  result.offices.SE.verifyUrl = 'https://search.prv.se/#/trademark';

  return new Response(JSON.stringify(result), { status: 200, headers: CORS });
}

// ---------- USPTO via Parse.bot ----------

async function fetchUSPTO(query) {
  const apiKey = Deno.env.get('PARSE_API_KEY');
  if (!apiKey) throw new Error('USPTO not configured - add PARSE_API_KEY');

  const url = 'https://api.parse.bot/scraper/82426fc4-aff3-4504-aa52-1dea89a26c73/search_trademarks' +
              `?limit=50&query=${encodeURIComponent(query)}&offset=0`;

  const r = await fetch(url, {
    headers: { 'X-API-Key': apiKey, Accept: 'application/json', 'User-Agent': UA },
  });
  const body = await r.text();
  console.log('[uspto] status:', r.status, 'body[:200]:', body.slice(0, 200));
  if (!r.ok) throw new Error(`Parse.bot HTTP ${r.status}: ${body.slice(0, 120)}`);

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

// ---------- EUIPO ----------
// Uses auth.euipo.europa.eu (IBM API Connect OAuth2 proxy).
// This endpoint is reachable from Cloudflare/Deno but NOT from AWS Lambda.
// IBM API Connect issues the token using the API Key/Secret from dev.euipo.europa.eu.

async function fetchEUIPO(query) {
  const clientId     = Deno.env.get('EUIPO_CLIENT_ID');
  const clientSecret = Deno.env.get('EUIPO_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('EUIPO not configured');

  // OAuth2 client credentials — IBM API Connect endpoint
  const basicAuth = btoa(`${clientId}:${clientSecret}`);
  console.log('[euipo] fetching token from auth.euipo.europa.eu, clientId:', clientId.slice(0, 8) + '...' + clientId.slice(-4));

  const tokenR = await fetch('https://auth.euipo.europa.eu/oidc/accessToken', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
      'User-Agent':    UA,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'uid' }).toString(),
  });

  const tokenText = await tokenR.text();
  console.log('[euipo] token status:', tokenR.status, 'body[:200]:', tokenText.slice(0, 200));
  if (!tokenR.ok) throw new Error(`EUIPO token error ${tokenR.status}: ${tokenText.slice(0, 120)}`);

  const tokenData = JSON.parse(tokenText);
  const token     = tokenData.access_token;

  // Decode JWT to log claims (helpful for debugging)
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    console.log('[euipo] token claims:', JSON.stringify(payload));
  } catch (_) { /* ignore */ }

  // Search using RSQL wildcard on verbalElement
  const rsql   = `wordMarkSpecification.verbalElement==*${query}*`;
  const params = new URLSearchParams({ query: rsql, page: '0', size: '50' });
  const url    = `https://api.euipo.europa.eu/trademark-search/trademarks?${params}`;
  console.log('[euipo] GET', url);

  const r = await fetch(url, {
    headers: {
      'Authorization':   `Bearer ${token}`,
      'X-IBM-Client-Id': clientId,
      'Accept':          'application/json',
      'User-Agent':      UA,
    },
  });

  const body = await r.text();
  console.log('[euipo] search status:', r.status, 'body[:500]:', body.slice(0, 500));
  if (!r.ok) throw new Error(`EUIPO search HTTP ${r.status}: ${body.slice(0, 120)}`);

  const data  = JSON.parse(body);
  const items = data.trademarks || [];
  console.log('[euipo] totalElements:', data.totalElements, 'returned:', items.length);

  return items.map(t => ({
    name:       t.wordMarkSpecification?.verbalElement || '',
    holder:     (Array.isArray(t.applicants) ? t.applicants[0]?.name : '') || '',
    status:     t.status || '',
    appNumber:  t.applicationNumber || '',
    filingDate: fmtDate(t.applicationDate || ''),
    classes:    arrToStr(t.niceClasses || []),
    office:     'EM',
  }));
}

// ---------- PRV (Sweden) ----------
// No public API exists — always returns unknown; user directed to search.prv.se.
async function fetchPRV(_query) {
  throw new Error('Swedish PRV search unavailable in automated mode — verify at search.prv.se');
}

// ---------- helpers ----------

function buildOfficeResult(marks, query) {
  const q    = query.toLowerCase().trim();
  const live = marks.filter(m => LIVE_KEYWORDS.some(k => m.status.toLowerCase().includes(k)));
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
  const s = String(r).split('T')[0].replace(/-/g, '');
  return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : String(r).split('T')[0];
}
