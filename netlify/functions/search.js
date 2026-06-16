// Uses Node 18 native fetch — no manual gzip handling needed.

const WIPO_SEARCH = 'https://branddb.wipo.int/branddb/api/v1/search';

const LIVE_STATUS_KEYWORDS = [
  'registered', 'live', 'pending', 'published', 'filed', 'active',
  'application received', 'under examination', 'opposition', 'accepted',
];

const OFFICES = {
  US: { name: 'United States (USPTO)', flag: '🇺🇸', verifyUrl: 'https://tmsearch.uspto.gov/search/' },
  EM: { name: 'European Union (EUIPO)', flag: '🇪🇺', verifyUrl: 'https://euipo.europa.eu/eSearch/#advanced/trademarks' },
  SE: { name: 'Sweden (PRV)', flag: '🇸🇪', verifyUrl: 'https://tc.prv.se/VarumarkesDbWeb/?lang=EN' },
};

const RESPONSE_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: RESPONSE_HEADERS };
  }

  const q = (event.queryStringParameters?.q || '').trim();
  if (!q || q.length < 2) {
    return {
      statusCode: 400,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ error: 'Please enter a brand name (at least 2 characters).' }),
    };
  }

  try {
    const docs = await fetchWIPO(q);

    const result = {
      query: q,
      offices: {},
    };

    for (const [code, meta] of Object.entries(OFFICES)) {
      const officeDocs = docs.filter(d =>
        (d.office || d.tmOffice || '').toUpperCase() === code
      );
      result.offices[code] = {
        ...meta,
        ...buildOfficeResult(officeDocs, q),
      };
    }

    result.offices.SE.note =
      'WIPO coverage of Swedish national marks may be partial. Verify at PRV directly.';

    return {
      statusCode: 200,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('[search] error:', err);
    return {
      statusCode: 502,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({
        error: 'Could not reach the WIPO trademark database. Please try again.',
        detail: err.message,
      }),
    };
  }
};

// ---------------------------------------------------------------------------
// WIPO fetch using native fetch (Node 18)
// ---------------------------------------------------------------------------
async function fetchWIPO(query) {
  const params = new URLSearchParams({
    query,
    office: 'US,EM,SE',
    type: 'brandName',
    rows: '100',
    start: '0',
  });

  const url = `${WIPO_SEARCH}?${params}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Referer: 'https://branddb.wipo.int/branddb/en/',
        Origin: 'https://branddb.wipo.int',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WIPO returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from WIPO (${res.status}): ${text.slice(0, 300)}`);
  }

  return data?.response?.docs || [];
}

// ---------------------------------------------------------------------------
// Risk assessment for one office
// ---------------------------------------------------------------------------
function buildOfficeResult(docs, query) {
  const q = query.toLowerCase().trim();

  const marks = docs.map(d => ({
    name:       pickField(d, ['wordMark', 'tmName', 'brandName', 'markVerbal', 'markText', 'mark']),
    holder:     pickArrayField(d, ['holderName', 'holders', 'applicantName', 'applicants']),
    status:     pickField(d, ['tmStatus', 'statusCode', 'status', 'statusLabel']),
    appNumber:  pickField(d, ['applicationNumber', 'appNumber', 'appNum', 'tmNumber']),
    regNumber:  pickField(d, ['registrationNumber', 'regNumber', 'regNum']),
    filingDate: formatDate(pickField(d, ['applicationDate', 'filingDate', 'appDate'])),
    regDate:    formatDate(pickField(d, ['registrationDate', 'regDate'])),
    classes:    pickArrayField(d, ['niceClass', 'niceClasses', 'goodsAndServices', 'classes']),
    office:     d.office || d.tmOffice || '',
  }));

  const liveMarks = marks.filter(m =>
    LIVE_STATUS_KEYWORDS.some(kw => m.status.toLowerCase().includes(kw))
  );

  const exactMatch = liveMarks.some(m => m.name.toLowerCase() === q);

  let risk;
  if (exactMatch)          risk = 'red';
  else if (liveMarks.length > 0) risk = 'yellow';
  else                     risk = 'green';

  return { risk, totalMatches: docs.length, liveCount: liveMarks.length, marks };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pickField(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) {
      const v = obj[k];
      return Array.isArray(v) ? v.join('; ') : String(v);
    }
  }
  return '';
}

function pickArrayField(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) {
      const v = obj[k];
      return Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
  return '';
}

function formatDate(raw) {
  if (!raw) return '';
  const s = String(raw).replace(/-/g, '');
  if (s.length === 8) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return raw;
}
