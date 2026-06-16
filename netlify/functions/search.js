const https = require('https');
const zlib = require('zlib');

const WIPO_HOST = 'branddb.wipo.int';
const WIPO_PATH = '/branddb/api/v1/search';

// Status codes that indicate an active/live trademark (potential conflict)
const LIVE_STATUS_KEYWORDS = [
  'registered', 'live', 'pending', 'published', 'filed', 'active',
  'application received', 'under examination', 'opposition', 'accepted'
];

// WIPO office codes
const OFFICES = {
  US: { name: 'United States (USPTO)', flag: '🇺🇸', prLink: 'https://tmsearch.uspto.gov/search/' },
  EM: { name: 'European Union (EUIPO)', flag: '🇪🇺', prLink: 'https://euipo.europa.eu/eSearch/#advanced/trademarks' },
  SE: { name: 'Sweden (PRV)', flag: '🇸🇪', prLink: 'https://tc.prv.se/VarumarkesDbWeb/?lang=EN' },
};

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  const q = (event.queryStringParameters?.q || '').trim();

  if (!q || q.length < 2) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Please enter a brand name (at least 2 characters).' }),
    };
  }

  try {
    const raw = await fetchWIPO(q);
    const docs = raw?.response?.docs || [];

    const result = {
      query: q,
      totalFound: raw?.response?.numFound || docs.length,
      offices: {},
    };

    for (const [code, meta] of Object.entries(OFFICES)) {
      const officeDocs = docs.filter(d => d.office === code || d.tmOffice === code);
      result.offices[code] = {
        ...meta,
        ...buildOfficeResult(officeDocs, q),
      };
    }

    // Attach PRV direct search link for Sweden (since SE coverage may be partial in WIPO)
    result.offices.SE.note = 'Coverage of Swedish national marks in WIPO may be partial. Verify directly at PRV.';
    result.offices.SE.prLink = OFFICES.SE.prLink;

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error('Search error:', err);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: 'Could not reach the WIPO trademark database. Please try again.',
        detail: err.message,
      }),
    };
  }
};

// ---------------------------------------------------------------------------
// WIPO API fetch with gzip/brotli decompression
// ---------------------------------------------------------------------------
function fetchWIPO(query) {
  const params = new URLSearchParams({
    query,
    office: 'US,EM,SE',
    type: 'brandName',
    rows: '100',
    start: '0',
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: WIPO_HOST,
      path: `${WIPO_PATH}?${params}`,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://branddb.wipo.int/branddb/en/',
        Origin: 'https://branddb.wipo.int',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];

      const readStream = (stream) => {
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error(`JSON parse failed: ${e.message} — raw: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
          }
        });
        stream.on('error', reject);
      };

      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') {
        readStream(res.pipe(zlib.createGunzip()));
      } else if (enc === 'br') {
        readStream(res.pipe(zlib.createBrotliDecompress()));
      } else if (enc === 'deflate') {
        readStream(res.pipe(zlib.createInflate()));
      } else {
        readStream(res);
      }
    });

    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Process raw docs for one office into risk + structured marks list
// ---------------------------------------------------------------------------
function buildOfficeResult(docs, query) {
  const q = query.toLowerCase().trim();

  const marks = docs.map((d) => ({
    name: pickField(d, ['wordMark', 'tmName', 'brandName', 'markVerbal', 'markText', 'mark']),
    holder: pickArrayField(d, ['holderName', 'holders', 'applicantName', 'applicants']),
    status: pickField(d, ['tmStatus', 'statusCode', 'status', 'statusLabel']),
    appNumber: pickField(d, ['applicationNumber', 'appNumber', 'appNum', 'tmNumber']),
    regNumber: pickField(d, ['registrationNumber', 'regNumber', 'regNum']),
    filingDate: formatDate(pickField(d, ['applicationDate', 'filingDate', 'appDate'])),
    regDate: formatDate(pickField(d, ['registrationDate', 'regDate'])),
    classes: pickArrayField(d, ['niceClass', 'niceClasses', 'goodsAndServices', 'classes']),
    office: d.office || d.tmOffice || '',
    _raw: d, // kept for debugging; remove in prod if needed
  }));

  // Classify as live vs. expired/abandoned
  const liveMarks = marks.filter((m) =>
    LIVE_STATUS_KEYWORDS.some((kw) => m.status.toLowerCase().includes(kw))
  );

  // Risk assessment
  const exactMatch = liveMarks.find((m) => m.name.toLowerCase() === q);
  const closeMatch = liveMarks.find((m) => {
    const n = m.name.toLowerCase();
    return n !== q && (n.startsWith(q) || q.startsWith(n) || n === q);
  });

  let risk;
  if (exactMatch) {
    risk = 'red';
  } else if (liveMarks.length > 0) {
    risk = 'yellow';
  } else {
    risk = 'green';
  }

  return {
    risk,
    totalMatches: docs.length,
    liveCount: liveMarks.length,
    marks: marks.map((m) => {
      const { _raw, ...clean } = m;
      return clean;
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pickField(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) {
      const v = obj[k];
      return Array.isArray(v) ? v.join('; ') : String(v);
    }
  }
  return '';
}

function pickArrayField(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) {
      const v = obj[k];
      if (Array.isArray(v)) return v.join(', ');
      return String(v);
    }
  }
  return '';
}

function formatDate(raw) {
  if (!raw) return '';
  // Handle YYYYMMDD or YYYY-MM-DD
  const s = String(raw).replace(/-/g, '');
  if (s.length === 8) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return raw;
}
