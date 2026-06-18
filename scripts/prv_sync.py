#!/usr/bin/env python3
"""
PRV Trademark Daily Diff Sync
Downloads the latest daily diff from PRV FTP and applies changes to Supabase.
Run via GitHub Actions (see .github/workflows/prv-sync.yml).

PRV publishes diffs daily at ~02:00 UTC named: YYYY-MM-DD-SE-DIFF-INDX-NNNN.zip
This script runs at 04:00 UTC and picks up the most recent available file.
"""

import ftplib, zipfile, io, os, sys, json, datetime
import xml.etree.ElementTree as ET
import urllib.request, urllib.error, urllib.parse

SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    print('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables.')
    sys.exit(1)

FTP_HOST = 'opendata.prv.se'
FTP_USER = 'OpenDataSource'
FTP_PASS = 'opendata'
DIFF_DIR = 'TrademarkExport/NewExport/trademark/data/diff'
BATCH    = 500


# ---------- XML parsing (identical to prv_load.py) ----------

def parse_trademarks(xml_bytes):
    try:
        root = ET.fromstring(xml_bytes.decode('utf-8'))
    except ET.ParseError as e:
        print(f'  XML parse error: {e}')
        return []

    records = []
    for tm in root.findall('.//TradeMark'):
        op      = tm.get('operationCode', 'Insert')
        app_num = (tm.findtext('ApplicationNumber') or '').strip()
        if not app_num:
            continue

        classes = []
        for cn in tm.findall('.//ClassNumber'):
            txt = (cn.text or '').strip()
            if txt.isdigit():
                classes.append(int(txt))

        applicant = (tm.findtext('.//FreeFormatNameLine') or '').strip()

        records.append({
            'application_number':  app_num,
            'registration_number': (tm.findtext('RegistrationNumber') or '').strip() or None,
            'mark_text':           (tm.findtext('.//MarkVerbalElementText') or '').strip() or None,
            'mark_feature':        (tm.findtext('MarkFeature') or '').strip() or None,
            'mark_status':         (tm.findtext('MarkCurrentStatusCode') or '').strip() or None,
            'applicant_name':      applicant or None,
            'application_date':    (tm.findtext('ApplicationDate') or '').strip() or None,
            'registration_date':   (tm.findtext('RegistrationDate') or '').strip() or None,
            'expiry_date':         (tm.findtext('ExpiryDate') or '').strip() or None,
            'nice_classes':        classes or None,
            'kind_mark':           (tm.findtext('KindMark') or '').strip() or None,
            'operation_code':      op,
        })
    return records


def process_zip(zip_bytes):
    all_records = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for name in z.namelist():
            if name.endswith('.xml'):
                with z.open(name) as f:
                    all_records.extend(parse_trademarks(f.read()))
    return all_records


# ---------- Supabase REST ----------

def _request(method, path, data=None, params=None):
    url = f'{SUPABASE_URL}/rest/v1/{path}'
    if params:
        url += '?' + urllib.parse.urlencode(params)
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers={
        'apikey':        SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=minimal',
    })
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def upsert_batch(records):
    status, err = _request(
        'POST',
        'se_trademarks?on_conflict=application_number',
        data=records,
    )
    if status not in (200, 201):
        print(f'  Upsert error {status}: {err}')
    return status


def delete_record(app_num):
    status, _ = _request(
        'DELETE',
        'se_trademarks',
        params={'application_number': f'eq.{app_num}'},
    )
    return status


# ---------- main ----------

def main():
    today     = datetime.date.today()
    yesterday = today - datetime.timedelta(days=1)

    print(f'Connecting to PRV FTP ({today.isoformat()})...')
    ftp = ftplib.FTP(FTP_HOST)
    ftp.login(FTP_USER, FTP_PASS)
    ftp.cwd(DIFF_DIR)
    all_files = sorted(ftp.nlst())

    # Prefer yesterday's diff; fall back to today's if PRV ran early
    candidates = [
        f for f in all_files
        if f.startswith(yesterday.isoformat()) or f.startswith(today.isoformat())
    ]

    if not candidates:
        print(f'No diff files found for {yesterday} or {today}.')
        print(f'Last 5 available: {all_files[-5:]}')
        ftp.quit()
        sys.exit(0)

    total_records = 0
    for filename in candidates:
        print(f'Downloading {filename}...')
        buf = io.BytesIO()
        ftp.retrbinary(f'RETR {filename}', buf.write)
        size_kb = buf.tell() // 1024
        buf.seek(0)

        records  = process_zip(buf.read())
        inserts  = [r for r in records if r['operation_code'] in ('Insert', 'Update')]
        deletes  = [r for r in records if r['operation_code'] == 'Delete']

        for j in range(0, len(inserts), BATCH):
            upsert_batch(inserts[j:j + BATCH])

        for r in deletes:
            delete_record(r['application_number'])

        total_records += len(records)
        print(f'  {size_kb} KB  →  {len(inserts)} upserts, {len(deletes)} deletes')

    ftp.quit()
    print(f'Sync complete. {total_records} records processed.')


if __name__ == '__main__':
    main()
