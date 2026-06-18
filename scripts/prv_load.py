#!/usr/bin/env python3
"""
PRV Trademark Initial Load
Downloads the full trademark database from PRV FTP and loads into Supabase.
Run this ONCE to populate the table, then use GitHub Actions + prv_sync.py for daily updates.

Prerequisites:
  pip install requests  (or it falls back to urllib)

Usage:
  SUPABASE_URL=https://xxxx.supabase.co \
  SUPABASE_SERVICE_KEY=eyJ... \
  python3 scripts/prv_load.py

The full extract is several hundred thousand records spread across many ZIP files.
Expect this to run for 30–60 minutes depending on connection speed.
It is safe to interrupt and restart — upserts are idempotent.
"""

import ftplib, zipfile, io, os, sys, json, datetime
import xml.etree.ElementTree as ET
import urllib.request, urllib.error, urllib.parse

SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    print('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables.')
    sys.exit(1)

FTP_HOST  = 'opendata.prv.se'
FTP_USER  = 'OpenDataSource'
FTP_PASS  = 'opendata'
FULL_DIR  = 'TrademarkExport/NewExport/trademark/data/full'
BATCH     = 500


# ---------- XML parsing ----------

def parse_trademarks(xml_bytes):
    """Parse one PRV trademark XML file. Returns list of record dicts."""
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

        # Nice classes: .//ClassNumber under GoodsServicesDetails
        classes = []
        for cn in tm.findall('.//ClassNumber'):
            txt = (cn.text or '').strip()
            if txt.isdigit():
                classes.append(int(txt))

        # Applicant name (deeply nested)
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
    """Unzip and parse all XML files inside. Returns list of records."""
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
        'apikey':         SUPABASE_KEY,
        'Authorization':  f'Bearer {SUPABASE_KEY}',
        'Content-Type':   'application/json',
        'Prefer':         'resolution=merge-duplicates,return=minimal',
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
    status, err = _request(
        'DELETE',
        'se_trademarks',
        params={'application_number': f'eq.{app_num}'},
    )
    return status


# ---------- main ----------

def main():
    print('Connecting to PRV FTP...')
    ftp = ftplib.FTP(FTP_HOST)
    ftp.login(FTP_USER, FTP_PASS)
    ftp.cwd(FULL_DIR)

    files = sorted(ftp.nlst())
    print(f'Found {len(files)} full-extract ZIP files\n')

    total_records = 0
    for i, filename in enumerate(files, 1):
        print(f'[{i}/{len(files)}] {filename}')
        buf = io.BytesIO()
        ftp.retrbinary(f'RETR {filename}', buf.write)
        size_kb = buf.tell() // 1024
        buf.seek(0)

        records = process_zip(buf.read())
        to_upsert = [{k: v for k, v in r.items() if k != 'operation_code'}
                     for r in records if r['operation_code'] != 'Delete']
        to_delete = [r for r in records if r['operation_code'] == 'Delete']

        # Batch upsert
        for j in range(0, len(to_upsert), BATCH):
            chunk = to_upsert[j:j + BATCH]
            upsert_batch(chunk)

        # Deletes (rare in full extract, but handle anyway)
        for r in to_delete:
            delete_record(r['application_number'])

        total_records += len(records)
        print(f'  {size_kb} KB  →  {len(to_upsert)} upserts, {len(to_delete)} deletes  (running total: {total_records})')

    ftp.quit()
    print(f'\nDone. Total records processed: {total_records}')


if __name__ == '__main__':
    main()
