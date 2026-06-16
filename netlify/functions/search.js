// Brand Name Check — Trademark search across US (USPTO), EU (EUIPO), and Sweden (PRV).
// Uses direct public APIs. Discovers correct endpoints from each app's JS bundle if needed.

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

// EUIPO eSearch API
async function fetchEUIPO(query) {
  const jsonHdr = {
    Accept: 'application/json',
    'User-Agent': UA,
    Origin: 'https://euipo.europa.eu',
    Referer: 'https://euipo.europa.eu/eSearch/',
  };

  // Try known URL variants
  const candidates = [
    `https://euipo.europa.eu/eSearch/api/v1/trademarks?queryLang=en&pageSize=50&query=${encodeURIComponent(query)}`,
    `https://euipo.europa.eu/eSearch/api/v1/trademark?queryLang=en&pageSize=50&query=${encodeURIComponent(query)}`,
    `https://euipo.europa.eu/api/v1/trademarks?queryLang=en&pageSize=50&query=${encodeURIComponent(query)}`,
  ];

  for (const url of candidates) {
    const r = await fetch(url, { headers: jsonHdr });
    const body = await r.text();
    const isHtml = body.trimStart().startsWith('<') || body.includes('<!DOCTYPE') || body.includes('It works!');
    console.log('[euipo] try:', url.slice(40), '->', r.status, 'html?', isHtml, body.slice(0, 100));
    if (r.ok && !isHtml) return parseEUIPO(JSON.parse(body));
  }

  // Discover API URL from EUIPO eSearch homepage JS bundles
  const homeRes  = await fetch('https://euipo.europa.eu/eSearch/', { headers: { Accept: 'text/html', 'User-Agent': UA } });
  const homeHtml = await homeRes.text();
  const scripts  = [...homeHtml.matchAll(/src="([^"]*\.js[^"]*)"/g)].map(m => m[1]);
  console.log('[euipo] home scripts:', scripts.slice(0, 6).join(' | '));

  for (const src of scripts.slice(0, 5)) {
    const jsUrl = src.startsWith('http') ? src : 'https://euipo.europa.eu' + src;
    try {
      const jsRes  = await fetch(jsUrl, { headers: { 'User-Agent': UA } });
      const jsText = await jsRes.text();
      const refs   = [...new Set([
        ...[...jsText.matchAll(/["'`]((?:https?:\/\/[^"'`\s,)]*)?\/[^"'`\s,)]*trademark[^"'`\s,)]*)/gi)].map(m => m[1]),
      ])].slice(0, 10);
      if (refs.length) { console.log('[euipo] paths in bundle:', refs.join('\n')); break; }
    } catch { /* continue */ }
  }

  throw new Error('EUIPO: no working endpoint found — check [euipo] logs for discovered paths');
}

function parseEUIPO(data) {
  console.log('[euipo] keys:', Object.keys(data).join(','));
  const items = data.trademarks || data.items || data.results || data.data || [];
  console.log('[euipo] count:', items.length, 'first keys:', items[0] ? Object.keys(items[0]).join(',') : 'none');
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

// USPTO TrademarkSearch API
async function fetchUSPTO(query) {
  const jsonHdr = {
    Accept: 'application/json',
    'User-Agent': UA,
    Origin: 'https://tmsearch.uspto.gov',
    Referer: 'https://tmsearch.uspto.gov/',
  };

  const candidates = [
    `https://tmsearch.uspto.gov/search/search-information?searchInput=${encodeURIComponent(query)}&searchOption1=KW`,
    `https://tmsearch.uspto.gov/api/v1/search?q=${encodeURIComponent(query)}&rows=100`,
    `https://tmsearch.uspto.gov/api/v1/trademark/search?q=${encodeURIComponent(query)}&rows=100`,
  ];

  for (const url of candidates) {
    const r    = await fetch(url, { headers: jsonHdr });
    const body = await r.text();
    const isHtml = body.trimStart().startsWith('<');
    console.log('[uspto] try:', url.slice(35), '->', r.status, 'html?', isHtml, body.slice(0, 100));
    if (r.ok && !isHtml) return parseUSPTO(JSON.parse(body));
  }

  // Discover from homepage
  const homeRes  = await fetch('https://tmsearch.uspto.gov/', { headers: { Accept: 'text/html', 'User-Agent': UA } });
  const homeHtml = await homeRes.text();
  const scripts  = [...homeHtml.matchAll(/src="([^"]*\.js[^"]*)"/g)].map(m => m[1]);
  console.log('[uspto] home scripts:', scripts.slice(0, 6).join(' | '));

  for (const src of scripts.slice(0, 5)) {
    const jsUrl = src.startsWith('http') ? src : 'https://tmsearch.uspto.gov' + src;
    try {
      const jsRes  = await fetch(jsUrl, { headers: { 'User-Agent': UA } });
      const jsText = await jsRes.text();
      const refs   = [...new Set([
        ...[...jsText.matchAll(/["'`]((?:https?:\/\/[^"'`\s,)]*)?\/[^"'`\s,)]*(?:search|trademark)[^"'`\s,)]*)/gi)].map(m => m[1]),
      ])].slice(0, 10);
      if (refs.length) { console.log('[uspto] paths in bundle:', refs.join('\n')); break; }
    } catch { /* continue */ }
  }

  throw new Error('USPTO: no working endpoint found — check [uspto] logs for discovered paths');
}

function parseUSPTO(data) {
  console.log('[uspto] keys:', Object.keys(data).join(','));
  const items = data.marks || data.trademarks || data.results || data.hits?.hits || [];
  console.log('[uspto] count:', items.length, 'first keys:', items[0] ? Object.keys(items[0]).join(',') : 'none');
  return items.map(t => ({
    name:       t.wordMark || t.markText || t.text || '',
    holder:     t.ownerName || t.holderName || t.applicantName || '',
    status:     t.statusCode || t.statusDescription || t.status || '',
    appNumber:  t.serialNumber || t.registrationNumber || t.appNumber || '',
    filingDate: fmtDate(t.filingDate || t.applicationDate || ''),
    classes:    arrToStr(t.intlClass || t.niceClasses || t.classes || []),
    office:     'US',
  }));
}

// Sweden (PRV) — empty for now; users verify directly at PRV
async function fetchPRV(query) {
  return [];
}

// Risk assessment
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

function arrToStr(v) {
  if (Array.isArray(v)) return v.join(', ');
  return v ? String(v) : '';
}

function fmtDate(r) {
  if (!r) return '';
  const s = String(r).replace(/-/g, '');
  return s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : r;
}
