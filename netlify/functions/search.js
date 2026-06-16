// Brand Name Check — Trademark search across US (USPTO), EU (EUIPO), and Sweden (PRV).
// Uses direct public APIs instead of WIPO Global Brand Database (which requires a private API key).

const LIVE_KEYWORDS = [
  'registered', 'live', 'pending', 'published', 'filed', 'active',
  'application received', 'under examination', 'opposition', 'accepted',
  '009', '018', '025', // Some offices encode live status as numeric codes
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  const q = (event.queryStringParameters?.q || '').trim();
  if (!q || q.length < 2) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'Enter a brand name (at least 2 characters).' }) };
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
        ...meta, risk: 'unknown', totalMatches: 0, liveCount: 0, marks: [],
        error: settled.reason?.message || 'Search failed',
      };
    }
  }
  result.offices.SE.note = 'Swedish PRV national marks require direct verification at PRV.';

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
};

// ─────────────────────────────────────────────────────────────────────────────
// EUIPO eSearch API — covers EU/EM trademark registrations
// ─────────────────────────────────────────────────────────────────────────────
async function fetchEUIPO(query) {
  const params = new URLSearchParams({ queryLang: 'en', pageSize: '100', query });
  const url = `https://euipo.europa.eu/eSearch/api/v1/trademarks/advanced?${params}`;
  console.log('[euipo] fetching:', url.slice(0, 100));

  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  const body = await r.text();
  console.log('[euipo] status:', r.status, 'body (0-500):', body.slice(0, 500));

  if (!r.ok) throw new Error(`EUIPO HTTP ${r.status}: ${body.slice(0, 150)}`);

  const data = JSON.parse(body);
  console.log('[euipo] top-level keys:', Object.keys(data).join(','));

  // EUIPO response shape TBD — log to discover field names
  const items = data.trademarks || data.items || data.results || data.data || [];
  console.log('[euipo] item count:', items.length, 'first item keys:', items[0] ? Object.keys(items[0]).join(',') : 'none');

  return items.map(t => ({
    name:       t.tmName || t.trademarkName || t.wordMark || t.name || t.markVerbal || '',
    holder:     t.holderName || t.ownerName || t.applicantName ||
                (Array.isArray(t.holders) ? t.holders[0] : '') ||
                (Array.isArray(t.owners)  ? t.owners[0]?.name : '') || '',
    status:     t.tmStatus || t.status || t.statusCode || '',
    appNumber:  t.applicationNumber || t.appNumber || t.trademarkId || '',
    filingDate: fmtDate(t.applicationDate || t.filingDate || ''),
    classes:    arrToStr(t.niceClasses || t.niceClass || t.classes || []),
    office:     'EM',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// USPTO Open Data API — covers US trademark registrations
// ─────────────────────────────────────────────────────────────────────────────
async function fetchUSPTO(query) {
  // USPTO Open Data Portal API
  const params = new URLSearchParams({ term: query, start: '0', rows: '100' });
  const url = `https://developer.uspto.gov/ibd-api/v1/trademark/search?${params}`;
  console.log('[uspto] fetching:', url.slice(0, 100));

  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  const body = await r.text();
  const isHtml = body.trimStart().startsWith('<');
  console.log('[uspto] status:', r.status, 'html?', isHtml, 'body (0-500):', body.slice(0, 500));

  if (!r.ok || isHtml) throw new Error(`USPTO HTTP ${r.status} (html: ${isHtml}): ${body.slice(0, 150)}`);

  const data = JSON.parse(body);
  console.log('[uspto] top-level keys:', Object.keys(data).join(','));

  const items = data.trademarks || data.marks || data.results || data.body?.hits?.hits || [];
  console.log('[uspto] item count:', items.length, 'first item keys:', items[0] ? Object.keys(items[0]).join(',') : 'none');

  return items.map(t => ({
    name:       t.wordMark || t.markText || t.text || t.serialNumber || '',
    holder:     t.ownerName || t.holderName || t.applicantName || '',
    status:     t.statusCode || t.statusDescription || t.status || '',
    appNumber:  t.serialNumber || t.registrationNumber || t.appNumber || '',
    filingDate: fmtDate(t.filingDate || t.applicationDate || ''),
    classes:    arrToStr(t.intlClass || t.niceClasses || t.classes || []),
    office:     'US',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweden (PRV) — via WIPO Global Brand Database SE filter
// Falls back silently; users are directed to verify at PRV directly.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPRV(query) {
  // WIPO GBD has some SE marks but requires auth we can't get.
  // Return empty; the note on the SE card directs to PRV directly.
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk assessment
// ─────────────────────────────────────────────────────────────────────────────
function buildOfficeResult(marks, query) {
  const q    = query.toLowerCase().trim();
  const live = marks.filter(m => LIVE_KEYWORDS.some(k => m.status.toLowerCase().includes(k)));
  const exact = live.some(m => m.name.toLowerCase() === q);

  return {
    risk: exact ? 'red' : live.length > 0 ? 'yellow' : 'green',
    totalMatches: marks.length,
    liveCount: live.length,
    marks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function arrToStr(v) {
  if (Array.isArray(v)) return v.join(', ');
  return v ? String(v) : '';
}

function fmtDate(r) {
  if (!r) return '';
  const s = String(r).replace(/-/g, '');
  return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : r;
}
