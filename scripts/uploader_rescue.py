"""Resumable, serial uploader.jp preservation with a separate Windows supervisor.

Payloads, cookies, SQLite and telemetry live under --root, outside this repository.
Only source metadata is parsed; downloaded programs are never executed.
"""
from __future__ import annotations

import argparse
import contextlib
import ctypes
from ctypes import wintypes
import datetime as dt
from email.message import Message
from email.utils import parsedate_to_datetime
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
from urllib.parse import unquote, urljoin, urlparse
import uuid
import zipfile

import requests
from bs4 import BeautifulSoup
from http.cookiejar import LWPCookieJar

DEFAULT_ROOT = Path(r'D:\VIPRPG-Rescue\uploaderjp-202611')
REPO = Path(__file__).resolve().parent.parent
SEEDS = REPO / 'catch/uploaderjp-rescue-20261023/seed-inventory.json'
GIB = 1024 ** 3
NO_WINDOW = 0x08000000 if os.name == 'nt' else 0


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return {} if default is None else default


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for attempt in range(10):
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(.05)


@contextlib.contextmanager
def exclusive(path):
    """An OS-held lock, not a PID file that can survive a crash."""
    import msvcrt
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise RuntimeError('This workflow already has an active process: ' + path.name) from exc
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def within(root, *parts):
    result = root.joinpath(*parts).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError('Path escapes the workflow directory')
    return result


def safe_name(value):
    value = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '_', value).strip(' .')
    if not value:
        value = 'file.bin'
    if re.match(r'(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', value):
        value = '_' + value
    if len(value) > 140:
        suffix = Path(value).suffix[:16]
        value = value[:140 - len(suffix)] + suffix
    return value


def source_url(url):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    if parsed.scheme not in ('http', 'https') or not (
        host == 'uploader.jp' or host == 'getuploader.com' or host.endswith('.getuploader.com')
    ):
        raise ValueError('Unexpected source host: ' + host)
    if parsed.username or parsed.password:
        raise ValueError('Credentials are not permitted in source URLs')
    return url


def connect(root):
    db = sqlite3.connect(root / 'queue.sqlite', timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY, uploader TEXT NOT NULL, url TEXT NOT NULL,
        page_key TEXT UNIQUE NOT NULL, depth INTEGER NOT NULL, ordinal INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        retry_at REAL NOT NULL DEFAULT 0, capture TEXT, listed INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY, uploader TEXT NOT NULL, file_id TEXT NOT NULL,
        detail_url TEXT NOT NULL, original_name TEXT, listed_size TEXT, source_date TEXT,
        priority INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, retry_at REAL NOT NULL DEFAULT 0,
        local_path TEXT, size INTEGER, validation TEXT, error TEXT, completed_at TEXT,
        UNIQUE(uploader,file_id));
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, state TEXT NOT NULL,
        successful INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        streak INTEGER NOT NULL DEFAULT 0, max_streak INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, at TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL,
        item_id INTEGER, message TEXT NOT NULL, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS files_ready ON files(state,retry_at,priority,id);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);
    ''')
    db.commit()
    return db


def initialize(root, seeds=SEEDS):
    root.mkdir(parents=True, exist_ok=True)
    for name in ('files', 'source-pages', 'logs', 'reports', 'private'):
        (root / name).mkdir(exist_ok=True)
    settings_path = root / 'settings.json'
    if not settings_path.exists():
        write_json(settings_path, {'proxy_url': 'http://127.0.0.1:17997',
            'source_region': 'JP', 'request_interval_seconds': 2.0,
            'reserve_free_gib': 80, 'max_local_gib': 80,
            'read_timeout_seconds': 45, 'retry_delays_seconds': [10, 30, 90],
            'seed_inventory': str(seeds), 'foreground_alerts': True})
    data = read_json(seeds)
    directories = data.get('user_supplied_directory_seeds', [])
    if not directories:
        raise RuntimeError('No user-supplied directories in seed inventory')
    db = connect(root)
    for ordinal, entry in enumerate(directories):
        url = source_url(entry['entry_url'])
        db.execute('INSERT OR IGNORE INTO pages(uploader,url,page_key,depth,ordinal) VALUES(?,?,?,?,?)',
                   (entry['uploader'], url, entry['uploader'] + ':1', 0, ordinal))
    # Historical references are a fallback after the live-directory entries.
    for entry in data.get('file_candidates', []):
        host = next((h for h in entry['hosts'] if h in ('uu.getuploader.com', 'ux.getuploader.com')),
                    entry['hosts'][0])
        url = source_url(f"https://{host}/{entry['uploader']}/download/{entry['file_id']}")
        db.execute('INSERT OR IGNORE INTO files(uploader,file_id,detail_url,priority) VALUES(?,?,?,20)',
                   (entry['uploader'], entry['file_id'], url))
    db.commit()
    result = {'directories': db.execute('SELECT count(*) FROM pages').fetchone()[0],
              'files': db.execute('SELECT count(*) FROM files').fetchone()[0], 'root': str(root)}
    db.close()
    return result


class PauseRequested(Exception):
    pass


class NeedsInput(Exception):
    pass


class CapacityReached(NeedsInput):
    pass


class SourceChanged(Exception):
    pass


class IncompleteDownload(Exception):
    pass


class HaltDownload(Exception):
    pass


def incident_snapshot(root, report):
    """Retain a consistent queue plus local evidence without reading payload content."""
    directory = root / 'reports/incidents' / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8])
    directory.mkdir(parents=True)
    evidence = {**report, 'captured_at': now(), 'directory': str(directory), 'capture_errors': []}
    for name in ('status.json', 'launch.json', 'supervisor.json', 'settings.json', 'latest-error.json'):
        path = root / name
        if path.exists():
            shutil.copyfile(path, directory / name)
    control = read_json(root / 'private/proxy-control.json')
    write_json(directory / 'proxy-context.json', {k: control.get(k) for k in ('proxy_url', 'controller', 'node', 'region', 'executable')})
    launch = read_json(root / 'launch.json')
    logs = [root / 'logs/events.jsonl', root / 'logs/proxy.stdout.log', root / 'logs/proxy.stderr.log']
    logs += [Path(launch[k]) for k in ('stdout', 'stderr') if launch.get(k)]
    for source in logs:
        if not source.is_file():
            continue
        with source.open('rb') as handle:
            handle.seek(max(0, source.stat().st_size - 256 * 1024))
            (directory / (source.name + '.tail')).write_bytes(handle.read())
    if (root / 'queue.sqlite').exists():
        try:
            with contextlib.closing(sqlite3.connect(root / 'queue.sqlite', timeout=5)) as source:
                with contextlib.closing(sqlite3.connect(directory / 'queue.sqlite')) as destination:
                    source.backup(destination)
                    evidence['queue_quick_check'] = destination.execute('PRAGMA quick_check').fetchone()[0]
        except sqlite3.Error as exc:
            evidence['capture_errors'].append('Queue snapshot: ' + str(exc))
    write_json(directory / 'incident.json', evidence)
    return directory


class Worker:
    def __init__(self, root, run_id):
        self.root, self.run_id = root, run_id
        self.settings = read_json(root / 'settings.json')
        self.db = connect(root)
        self.db.execute("INSERT INTO runs(id,started_at,state) VALUES(?,?,'running')", (run_id, now()))
        # Start is an explicit manual resume after inspection; it is never
        # invoked automatically after a genuine failure.
        self.db.execute("UPDATE files SET state='pending',error=NULL WHERE state IN ('downloading','failed','needs_input')")
        self.db.execute("UPDATE pages SET state='pending',error=NULL WHERE state IN ('listing','failed','needs_input')")
        self.db.commit()
        self.session = requests.Session()
        self.session.trust_env = False
        proxy = self.settings['proxy_url']
        self.session.proxies = {'http': proxy, 'https': proxy}
        self.session.headers.update({'User-Agent': 'Mozilla/5.0 VIPRPG-local-preservation/1.0',
                                     'Accept-Encoding': 'identity'})
        self.cookie_path = root / 'private/cookies.txt'
        self.session.cookies = LWPCookieJar(str(self.cookie_path))
        if self.cookie_path.exists():
            self.session.cookies.load(ignore_discard=True, ignore_expires=False)
        self.last_request = 0.0
        self.source_retry_at = read_json(root / 'private/source-cooldown.json').get('until', 0.0)
        self.last_response_failure = None
        self.state_lock = threading.Lock()
        self.state = {'run_id': run_id, 'worker_pid': os.getpid(), 'started_at': now(),
                      'running': True, 'stage': 'starting', 'last_progress_at': now(),
                      'root': str(root), 'source_region': self.settings['source_region'],
                      'consecutive_success': 0, 'max_streak': 0, 'run_successful': 0,
                      'run_errors': 0, 'latest_error_event': 0}
        self.ending = threading.Event()
        self.heartbeat = threading.Thread(target=self.publish_loop, daemon=True)
        self.refresh()
        self.heartbeat.start()

    def stop_check(self):
        if (self.root / 'stop.request').exists():
            raise PauseRequested('User requested pause; files and checkpoints retained')

    def wait(self, seconds, stage=None):
        if stage:
            self.update(stage=stage, wait_seconds=round(seconds, 1))
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.stop_check()
            time.sleep(min(.25, max(0, deadline - time.monotonic())))

    def update(self, **values):
        with self.state_lock:
            self.state.update(values)
            self.state['last_progress_at'] = now()

    def refresh(self):
        counts = dict(self.db.execute('SELECT state,count(*) FROM files GROUP BY state').fetchall())
        page_counts = dict(self.db.execute('SELECT state,count(*) FROM pages GROUP BY state').fetchall())
        total_bytes = self.db.execute("SELECT coalesce(sum(size),0) FROM files WHERE state='done'").fetchone()[0]
        run = self.db.execute('SELECT * FROM runs WHERE id=?', (self.run_id,)).fetchone()
        retries = dict(self.db.execute("SELECT kind,count(*) FROM events WHERE run_id=? AND kind IN ('retry','retry_recovered') GROUP BY kind", (self.run_id,)).fetchall())
        self.update(counts=counts, page_counts=page_counts, completed_bytes=total_bytes,
                    run_successful=run['successful'], run_errors=run['errors'],
                    retry_attempts=retries.get('retry', 0), recovered_retries=retries.get('retry_recovered', 0),
                    consecutive_success=run['streak'], max_streak=run['max_streak'],
                    free_bytes=shutil.disk_usage(self.root).free)

    def publish_loop(self):
        while not self.ending.is_set():
            with self.state_lock:
                snapshot = {**self.state, 'heartbeat_at': now()}
            try:
                write_json(self.root / 'status.json', snapshot)
            except Exception:
                traceback.print_exc()
            self.ending.wait(1)

    def event(self, kind, message, item_id=None, **details):
        stamp = now()
        cursor = self.db.execute('INSERT INTO events(at,run_id,kind,item_id,message,details) VALUES(?,?,?,?,?,?)',
                                 (stamp, self.run_id, kind, item_id, message, json.dumps(details, ensure_ascii=False)))
        self.db.commit()
        record = {'id': cursor.lastrowid, 'at': stamp, 'run_id': self.run_id,
                  'kind': kind, 'item_id': item_id, 'message': message, **details}
        with (self.root / 'logs/events.jsonl').open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + '\n')
        print(json.dumps(record, ensure_ascii=False), flush=True)
        return record

    def error(self, message, item_id=None, **details):
        self.db.execute('UPDATE runs SET errors=errors+1,streak=0 WHERE id=?', (self.run_id,))
        event = self.event('error', message, item_id, **details)
        self.update(latest_error_event=event['id'], last_error=message)
        write_json(self.root / 'latest-error.json', event)
        self.refresh()

    def request(self, method, url, **kwargs):
        for _ in range(8):
            self.stop_check()
            source_url(url)
            if self.source_retry_at > time.time():
                self.wait(self.source_retry_at - time.time(), 'rate_limit_wait')
            remaining = float(self.settings['request_interval_seconds']) - (time.monotonic() - self.last_request)
            if remaining > 0:
                self.wait(remaining)
            self.last_request = time.monotonic()
            response = self.session.request(method, url, timeout=(15, self.settings['read_timeout_seconds']),
                                            allow_redirects=False, stream=True, **kwargs)
            self.session.cookies.save(ignore_discard=True, ignore_expires=False)
            if response.status_code in (301, 302, 303, 307, 308):
                destination = urljoin(url, response.headers.get('Location', ''))
                source_url(destination)
                if response.status_code == 303 or (response.status_code in (301, 302) and method == 'POST'):
                    method = 'GET'
                    kwargs.pop('data', None)
                response.close()
                url = destination
                continue
            try:
                response.raise_for_status()
            except requests.HTTPError:
                self.capture_response_failure(response, method, url)
                response.close()
                raise
            return response
        raise RuntimeError('Source redirect loop')

    def capture_response_failure(self, response, method, requested_url):
        directory = self.root / 'private/response-failures'
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / (uuid.uuid4().hex + '.bin')
        capture_error = None
        try:
            # A bounded original response, retained as bytes, never rendered.
            payload = response.raw.read(65536, decode_content=True)
            path.write_bytes(payload)
        except Exception as exc:
            payload = b''
            capture_error = repr(exc)
        headers = {k: v for k, v in response.headers.items() if k.lower() not in ('set-cookie', 'authorization', 'proxy-authorization')}
        metadata = {'at': now(), 'method': method, 'requested_url': requested_url,
                    'response_url': response.url, 'status': response.status_code,
                    'headers': headers, 'captured_bytes': len(payload),
                    'body_limit': 65536, 'capture_error': capture_error, 'body': str(path)}
        write_json(path.with_suffix('.json'), metadata)
        self.last_response_failure = str(path.with_suffix('.json'))

    def page(self, url, method='GET', data=None):
        self.update(stage='reading_page', active_url=url)
        with self.request(method, url, **({'data': data} if data is not None else {})) as response:
            body = bytearray()
            for chunk in response.iter_content(128 * 1024):
                self.stop_check()
                body.extend(chunk)
                if len(body) > 8 * 1024 * 1024:
                    raise RuntimeError('Unexpectedly large source HTML response')
            actual = response.url
            capture = self.root / 'source-pages' / (uuid.uuid4().hex + '.html')
            capture.write_bytes(body)
            write_json(capture.with_suffix('.json'), {'at': now(), 'requested_url': url,
                'actual_url': actual, 'method': method, 'status': response.status_code,
                'bytes': len(body), 'content_type': response.headers.get('Content-Type')})
        soup = BeautifulSoup(bytes(body), 'html.parser')
        return soup, actual, str(capture.relative_to(self.root))

    def get_page(self, url):
        soup, actual, capture = self.page(url)
        # The service's age-confirmation page has only a hidden q field and a POST.
        for _ in range(2):
            gate = next((f for f in soup.find_all('form') if
                str(f.get('method', '')).lower() == 'post' and f.select_one('input[name=q][type=hidden]')
                and not f.select_one('input[type=password]')), None)
            if gate is None:
                return soup, actual, capture
            data = {i['name']: i.get('value', '') for i in gate.select('input[name]')}
            soup, actual, capture = self.page(urljoin(actual, gate.get('action') or actual), 'POST', data)
        raise NeedsInput('Source confirmation page did not yield a listing')

    def discover(self, row):
        self.db.execute("UPDATE pages SET state='listing',attempts=attempts+1 WHERE id=?", (row['id'],))
        self.db.commit()
        self.update(active_item=f"{row['uploader']} / 目录", file_bytes=0, file_total=0, speed_bps=0)
        soup, actual, capture = self.get_page(row['url'])
        found = {}
        for tr in soup.select('table tr'):
            for anchor in tr.select('a[href]'):
                url = urljoin(actual, anchor['href'])
                parsed = urlparse(url)
                match = re.fullmatch(r'/([^/]+)/download/(\d+)(?:/.*)?', parsed.path)
                if not match or match[1] != row['uploader'] or not (parsed.hostname or '').endswith('.getuploader.com'):
                    continue
                cells = tr.find_all('td', recursive=False)
                name = cells[2].get_text(' ', strip=True) if len(cells) >= 5 else anchor.get_text(' ', strip=True)
                size = cells[3].get_text(' ', strip=True) if len(cells) >= 5 else None
                date = cells[4].get_text(' ', strip=True) if len(cells) >= 5 else None
                found[match[2]] = (url, name, size, date)
        stats = {}
        for tr in soup.select('table tr'):
            th, td = tr.find('th'), tr.find('td')
            if th and td:
                label = th.get_text(' ', strip=True)
                if label in ('ディスク', 'ファイル'):
                    stats[label] = td.get_text(' ', strip=True)
        if not found and not re.match(r'^0\s', stats.get('ファイル', '')):
            if soup.select_one('input[type=password]'):
                raise NeedsInput('Uploader listing requires a password')
            raise RuntimeError('No file rows or explicit zero-file statistic in source listing')
        for fid, (url, name, size, date) in found.items():
            self.db.execute('''INSERT INTO files(uploader,file_id,detail_url,original_name,listed_size,source_date,priority)
                VALUES(?,?,?,?,?,?,0) ON CONFLICT(uploader,file_id) DO UPDATE SET
                detail_url=excluded.detail_url,original_name=excluded.original_name,
                listed_size=excluded.listed_size,source_date=excluded.source_date,priority=0''',
                (row['uploader'], fid, url, name, size, date))
        for anchor in soup.select('ul.pagination a[href]'):
            if anchor.get_text(' ', strip=True) != '次へ':
                continue
            url = source_url(urljoin(actual, anchor['href']))
            match = re.fullmatch(r'/' + re.escape(row['uploader']) + r'/index/date/desc/(\d+)/?', urlparse(url).path)
            if not match:
                raise RuntimeError('Unrecognized next-page link; listing checkpoint retained')
            self.db.execute('INSERT OR IGNORE INTO pages(uploader,url,page_key,depth,ordinal) VALUES(?,?,?,?,?)',
                            (row['uploader'], url, row['uploader'] + ':' + match[1], int(match[1]) - 1, row['ordinal']))
        self.db.execute("UPDATE pages SET state='done',capture=?,listed=?,error=NULL WHERE id=?", (capture, len(found), row['id']))
        self.db.commit()
        self.event('page_listed', 'Directory page captured', uploader=row['uploader'],
                   page_id=row['id'], found=len(found), capture=capture, displayed_statistics=stats)
        self.refresh()

    def resolve(self, row):
        soup, actual, capture = self.get_page(row['detail_url'])
        fields = {}
        for tr in soup.select('table tr'):
            th, td = tr.find('th'), tr.find('td')
            if th and td:
                label = th.get_text(' ', strip=True)
                if label in ('ファイル', 'オリジナル', '容量', '日時'):
                    fields[label] = td.get_text(' ', strip=True)
        original = fields.get('オリジナル') or fields.get('ファイル') or row['original_name']
        form = next((f for f in soup.find_all('form') if f.select_one('input[name=token]')), None)
        if form is not None:
            if form.select_one('input[type=password]'):
                raise NeedsInput('File download requires a password')
            data = {i['name']: i.get('value', '') for i in form.select('input[name]')}
            soup, actual, capture = self.page(urljoin(actual, form.get('action') or actual), 'POST', data)
        link, delay = None, 0
        refresh = soup.find('meta', attrs={'http-equiv': re.compile('^refresh$', re.I)})
        if refresh:
            match = re.match(r'\s*(\d+)\s*;\s*URL\s*=\s*(.+)', refresh.get('content', ''), re.I)
            if match:
                delay, link = int(match[1]), urljoin(actual, match[2].strip('"\''))
        if not link:
            link = next((urljoin(actual, a['href']) for a in soup.select('a[href]') if
                (urlparse(urljoin(actual, a['href'])).hostname or '').endswith('.getuploader.com')
                and urlparse(urljoin(actual, a['href'])).path.startswith('/g/')), None)
        if not link:
            raise NeedsInput('Download form did not yield a file URL; source page retained')
        source_url(link)
        if delay:
            self.wait(delay, 'source_countdown')
        return link, original or unquote(urlparse(link).path.rsplit('/', 1)[-1]), actual, capture

    def capacity(self, extra=0):
        free = shutil.disk_usage(self.root).free
        if free - extra < self.settings['reserve_free_gib'] * GIB:
            raise CapacityReached('Free disk space would fall below the configured reserve')
        used = sum(p.stat().st_size for p in (self.root / 'files').rglob('*') if p.is_file())
        if used + extra > self.settings['max_local_gib'] * GIB:
            raise CapacityReached('Local preservation capacity limit reached; retained files are not deleted')

    def download(self, row):
        self.capacity()
        self.db.execute("UPDATE files SET state='downloading',attempts=attempts+1 WHERE id=?", (row['id'],))
        self.db.commit()
        self.update(active_item=f"{row['uploader']} / {row['file_id']}", file_bytes=0, file_total=0, speed_bps=0)
        directory = within(self.root, 'files', row['uploader'], row['file_id'])
        directory.mkdir(parents=True, exist_ok=True)
        part, metadata = directory / 'payload.part', directory / 'transfer.json'
        previous = read_json(metadata)
        offset = part.stat().st_size if part.exists() else 0
        same_record = previous.get('uploader') == row['uploader'] and previous.get('file_id') == row['file_id']
        if same_record and previous.get('total') is not None:
            recovered = part if part.exists() else within(self.root, previous['target'])
            if recovered.is_file() and recovered.stat().st_size == previous['total']:
                self.finish_download(row, recovered, previous['original_filename'], previous['total'])
                return
        link, original, referer, capture = self.resolve(row)
        validator_kind = 'etag'
        validator = previous.get('etag')
        if not validator or str(validator).startswith('W/'):
            validator_kind = 'last_modified'
            validator = previous.get('last_modified')
        if offset and not validator:
            part.rename(directory / ('unconfirmed-' + uuid.uuid4().hex[:8] + '.part'))
            offset = 0
        headers = {'Referer': referer, 'Accept-Encoding': 'identity'}
        if offset:
            headers.update({'Range': f'bytes={offset}-', 'If-Range': validator})
        with self.request('GET', link, headers=headers) as response:
            total = int(response.headers['Content-Length']) if response.headers.get('Content-Length', '').isdigit() else None
            if response.status_code == 206:
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                if not match or int(match[1]) != offset or int(match[2]) + 1 != int(match[3]):
                    raise RuntimeError('Invalid Content-Range; partial file retained')
                total = int(match[3])
                observed = response.headers.get('ETag' if validator_kind == 'etag' else 'Last-Modified')
                if previous.get('total') != total or observed != validator:
                    part.rename(directory / ('unconfirmed-' + uuid.uuid4().hex[:8] + '.part'))
                    raise SourceChanged('Resumed source version/size could not be confirmed; old partial preserved and next attempt starts fresh')
            elif response.status_code == 200 and offset:
                part.rename(directory / ('unconfirmed-' + uuid.uuid4().hex[:8] + '.part'))
                offset = 0
            elif response.status_code != 200:
                raise RuntimeError('Unexpected binary response status ' + str(response.status_code))
            disposition = Message()
            disposition['Content-Disposition'] = response.headers.get('Content-Disposition', '')
            filename = disposition.get_filename() or original
            try:
                filename = filename.encode('latin-1').decode('utf-8')
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
            target = directory / safe_name(filename)
            if target.exists():
                raise NeedsInput('Destination already exists without a completed queue record; retained for review')
            if total is None:
                raise RuntimeError('Source file has no exact response length')
            self.capacity(total - offset)
            ctype = response.headers.get('Content-Type', '').lower()
            if 'text/html' in ctype and not (Path(filename).suffix.lower() in ('.html', '.htm') and disposition.get_filename()):
                self.capture_response_failure(response, 'GET', link)
                raise RuntimeError('Source returned HTML instead of the expected file')
            transfer = {'uploader': row['uploader'], 'file_id': row['file_id'],
                'detail_url': row['detail_url'], 'original_filename': filename,
                'total': total, 'etag': response.headers.get('ETag'),
                'last_modified': response.headers.get('Last-Modified'), 'content_type': ctype,
                'target': str(target.relative_to(self.root)), 'detail_capture': capture, 'at': now()}
            write_json(metadata, transfer)
            self.update(stage='downloading', active_filename=filename, file_bytes=offset, file_total=total, speed_bps=0)
            received, mark, at_mark, check_at = offset, offset, time.monotonic(), offset
            with part.open('ab' if offset else 'wb') as handle:
                first = offset == 0
                for chunk in response.iter_content(256 * 1024):
                    self.stop_check()
                    if not chunk:
                        continue
                    if first:
                        first = False
                        if chunk.lstrip()[:64].lower().startswith((b'<!doctype html', b'<html')) and Path(filename).suffix.lower() not in ('.html', '.htm'):
                            failure = self.root / 'private/response-failures' / (uuid.uuid4().hex + '.bin')
                            failure.parent.mkdir(parents=True, exist_ok=True)
                            failure.write_bytes(chunk[:65536])
                            self.last_response_failure = str(failure)
                            raise RuntimeError('HTML error body detected in binary transfer')
                    handle.write(chunk)
                    received += len(chunk)
                    if received > total:
                        raise RuntimeError('Response exceeds declared file length')
                    elapsed = time.monotonic() - at_mark
                    if elapsed >= .5:
                        self.update(file_bytes=received, speed_bps=(received - mark) / elapsed)
                        mark, at_mark = received, time.monotonic()
                    if received - check_at >= 16 * 1024 * 1024:
                        if shutil.disk_usage(self.root).free < self.settings['reserve_free_gib'] * GIB:
                            raise CapacityReached('Disk reserve reached during download; partial file retained')
                        check_at = received
                handle.flush()
                os.fsync(handle.fileno())
        self.finish_download(row, part, filename, total)

    def finish_download(self, row, part, filename, total):
        if part.stat().st_size != total:
            raise IncompleteDownload('Downloaded byte count differs from Content-Length')
        target = part.parent / safe_name(filename)
        if target != part and target.exists():
            raise NeedsInput('Destination exists; neither local file was overwritten')
        validation = 'exact_http_length'
        self.update(stage='validating', file_bytes=total, speed_bps=0)
        if Path(filename).suffix.lower() == '.zip':
            try:
                with zipfile.ZipFile(part) as archive:
                    entries = archive.infolist()
                    if any(x.flag_bits & 1 for x in entries):
                        validation += '+zip_directory_encrypted'
                    elif sum(x.file_size for x in entries) <= 8 * GIB:
                        for entry in entries:
                            self.stop_check()
                            with archive.open(entry) as member:
                                while member.read(1024 * 1024):
                                    self.stop_check()
                        validation += '+zip_crc_all_entries'
                    else:
                        validation += '+zip_directory_large'
            except (zipfile.BadZipFile, RuntimeError) as exc:
                raise NeedsInput('ZIP structure/CRC check failed; original bytes retained for review') from exc
        if target != part:
            os.replace(part, target)
        finished = now()
        self.db.execute("UPDATE files SET state='done',local_path=?,size=?,validation=?,completed_at=?,error=NULL WHERE id=?",
                        (str(target.relative_to(self.root)), total, validation, finished, row['id']))
        self.db.execute('UPDATE runs SET successful=successful+1,streak=streak+1,max_streak=max(max_streak,streak+1) WHERE id=?', (self.run_id,))
        self.db.commit()
        self.event('file_complete', 'File saved and checked', row['id'], uploader=row['uploader'],
                   file_id=row['file_id'], local_path=str(target.relative_to(self.root)), size=total, validation=validation)
        self.refresh()
        streak = self.db.execute('SELECT streak FROM runs WHERE id=?', (self.run_id,)).fetchone()[0]
        if streak == 50:
            events = [dict(x) for x in self.db.execute("SELECT * FROM events WHERE run_id=? AND kind='file_complete' ORDER BY id DESC LIMIT 50", (self.run_id,))]
            write_json(self.root / 'reports' / ('milestone-50-' + self.run_id + '.json'),
                       {'at': now(), 'run_id': self.run_id, 'consecutive_success': 50,
                        'file_events': list(reversed(events)), 'note': 'Real source downloads; errors reset the streak.'})
            self.event('milestone_50', '50 consecutive files completed without a recorded error')

    @staticmethod
    def retryable(exc):
        if isinstance(exc, requests.exceptions.SSLError) and 'CERTIFICATE_VERIFY_FAILED' in str(exc):
            return False
        if isinstance(exc, requests.HTTPError):
            return exc.response is not None and exc.response.status_code in (408, 425, 429, 500, 502, 503, 504)
        return isinstance(exc, (requests.ConnectionError, requests.Timeout,
                                requests.exceptions.ChunkedEncodingError,
                                SourceChanged, IncompleteDownload))

    def process_item(self, table, row, operation):
        """Retry the same item; only an unrecovered failure is an error."""
        delays = self.settings['retry_delays_seconds']
        for attempt in range(len(delays) + 1):
            self.last_response_failure = None
            try:
                operation(row)
                if attempt:
                    self.event('retry_recovered', 'Temporary failure recovered; not counted as an error',
                               row['id'], table=table, retry_count=attempt)
                    self.refresh()
                return
            except PauseRequested:
                raise
            except Exception as exc:
                message = f'{table} {row["uploader"]}/{row["file_id"] if table == "files" else row["id"]}: {type(exc).__name__}: {exc}'
                trace = traceback.format_exc()
                if self.retryable(exc) and attempt < len(delays):
                    delay = delays[attempt]
                    response = getattr(exc, 'response', None)
                    if response is not None and response.status_code in (429, 503):
                        value = response.headers.get('Retry-After', '')
                        try:
                            limit = time.time() + int(value) if value.isdigit() else parsedate_to_datetime(value).timestamp()
                        except (ValueError, TypeError, OverflowError):
                            limit = time.time() + delay
                        self.source_retry_at = max(self.source_retry_at, time.time() + delay, limit)
                        write_json(self.root / 'private/source-cooldown.json', {'until': self.source_retry_at})
                        delay = max(delay, self.source_retry_at - time.time())
                    self.db.execute(f"UPDATE {table} SET state='pending',retry_at=?,error=NULL WHERE id=?",
                                    (time.time() + delay, row['id']))
                    self.db.commit()
                    self.event('retry', message, row['id'], table=table, attempt=attempt + 1,
                               retry_in_seconds=delay, traceback=trace,
                               response_capture=self.last_response_failure)
                    self.update(last_retry=message, stage='retry_wait')
                    self.refresh()
                    self.wait(delay, 'retry_wait')
                    continue
                state = 'needs_input' if isinstance(exc, NeedsInput) else 'failed'
                self.db.execute(f'UPDATE {table} SET state=?,retry_at=0,error=? WHERE id=?',
                                (state, message, row['id']))
                self.db.commit()
                self.update(stage='collecting_diagnostics', last_error=message)
                report = {'run_id': self.run_id, 'failure_kind': 'unrecovered_item',
                          'table': table, 'item': dict(row), 'attempts_this_run': attempt + 1,
                          'exception_type': type(exc).__name__, 'message': message,
                          'traceback': trace, 'response_capture': self.last_response_failure,
                          'download_directory': str(self.root / 'files' / row['uploader'] / row['file_id']) if table == 'files' else None}
                try:
                    directory = incident_snapshot(self.root, report)
                    self.update(incident_directory=str(directory))
                except Exception as capture_exc:
                    directory = None
                    traceback.print_exc()
                    self.update(incident_capture_error=str(capture_exc))
                self.error(message, row['id'], table=table, attempts=attempt + 1,
                           incident_directory=str(directory) if directory else None)
                raise HaltDownload(message) from exc

    def run(self):
        since_discovery = 8
        terminal = 'complete'
        try:
            self.event('run_started', 'Serial local preservation started')
            while True:
                self.stop_check()
                page = self.db.execute("SELECT * FROM pages WHERE state='pending' AND retry_at<=? ORDER BY depth,ordinal,id LIMIT 1", (time.time(),)).fetchone()
                item = self.db.execute("SELECT * FROM files WHERE state='pending' AND retry_at<=? ORDER BY priority,id LIMIT 1", (time.time(),)).fetchone()
                if page and (since_discovery >= 8 or item is None or item['priority'] > 0):
                    self.process_item('pages', page, self.discover)
                    since_discovery = 0
                    continue
                if item:
                    self.process_item('files', item, self.download)
                    since_discovery += 1
                    continue
                pending = self.db.execute("SELECT count(*) FROM files WHERE state='pending'").fetchone()[0] + self.db.execute("SELECT count(*) FROM pages WHERE state='pending'").fetchone()[0]
                if pending:
                    self.wait(2, 'retry_wait')
                    continue
                unresolved = self.db.execute("SELECT count(*) FROM files WHERE state!='done'").fetchone()[0] + self.db.execute("SELECT count(*) FROM pages WHERE state!='done'").fetchone()[0]
                terminal = 'attention_required' if unresolved else 'complete'
                break
        except PauseRequested:
            terminal = 'paused'
            self.event('paused', 'Pause requested; all files and checkpoints retained')
        except HaltDownload:
            terminal = 'attention_required'
        except BaseException as exc:
            terminal = 'attention_required'
            try:
                directory = incident_snapshot(self.root, {'run_id': self.run_id,
                    'failure_kind': 'unexpected_worker_exception', 'message': str(exc),
                    'traceback': traceback.format_exc()})
                self.update(incident_directory=str(directory))
            except Exception:
                traceback.print_exc()
            self.error('Worker stopped: ' + str(exc))
            traceback.print_exc()
        finally:
            self.db.execute("UPDATE files SET state='pending' WHERE state='downloading'")
            self.db.execute("UPDATE pages SET state='pending' WHERE state='listing'")
            self.db.execute('UPDATE runs SET state=?,ended_at=? WHERE id=?', (terminal, now(), self.run_id))
            self.db.commit()
            self.refresh()
            self.update(stage=terminal, running=False, speed_bps=0)
            self.ending.set()
            self.heartbeat.join(5)
            write_json(self.root / 'status.json', {**self.state, 'heartbeat_at': now()})
            self.session.close()
            self.db.close()
        return 0 if terminal in ('complete', 'paused') else 2


def spawn(root, action, *extra):
    (root / 'logs').mkdir(parents=True, exist_ok=True)
    with (root / 'logs' / (action + '.stdout.log')).open('ab') as output, (root / 'logs' / (action + '.stderr.log')).open('ab') as error:
        return subprocess.Popen([sys.executable, '-X', 'faulthandler', str(Path(__file__).resolve()),
                                 '--root', str(root), action, *extra],
                                creationflags=NO_WINDOW, close_fds=True,
                                stdin=subprocess.DEVNULL, stdout=output, stderr=error)


def ensure_proxy(root):
    control = read_json(root / 'private/proxy-control.json')
    if control.get('region') != 'JP':
        raise RuntimeError('A dedicated Japan proxy configuration is required')
    session = requests.Session()
    session.trust_env = False
    headers = {'Authorization': 'Bearer ' + control['secret']}
    def check():
        response = session.get(control['controller'] + '/proxies', headers=headers, timeout=3)
        response.raise_for_status()
        if control['node'] not in response.json().get('proxies', {}):
            raise RuntimeError('Dedicated proxy has an unexpected node configuration')
    try:
        check()
    except requests.RequestException:
        with (root / 'logs/proxy.stdout.log').open('ab') as output, (root / 'logs/proxy.stderr.log').open('ab') as error:
            child = subprocess.Popen([control['executable'], '-d', str(root / 'private'), '-f', control['config']],
                                     creationflags=NO_WINDOW, stdout=output, stderr=error, stdin=subprocess.DEVNULL)
        write_json(root / 'private/proxy-process.json', {'pid': child.pid, 'started_at': now()})
        for _ in range(30):
            if child.poll() is not None:
                raise RuntimeError('Dedicated proxy exited; see proxy.stderr.log')
            try:
                check()
                break
            except requests.RequestException:
                time.sleep(.2)
        else:
            raise RuntimeError('Dedicated proxy did not become ready')
    finally:
        session.close()


def active_error_events(root, run_id):
    """Only unresolved queue errors; history is not an outstanding incident."""
    with contextlib.closing(sqlite3.connect(
            'file:' + (root / 'queue.sqlite').as_posix() + '?mode=ro',
            uri=True, timeout=2)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute("SELECT * FROM events WHERE run_id=? AND kind='error' ORDER BY id DESC",
                          (run_id,)).fetchall()
        active, seen = [], set()
        status = read_json(root / 'status.json')
        for row in rows:
            event = dict(row)
            details = json.loads(event['details'])
            table = details.get('table')
            if table in ('files', 'pages') and event['item_id'] is not None:
                key = (table, event['item_id'])
                if key in seen:
                    continue
                seen.add(key)
                item = db.execute(f'SELECT state,error FROM {table} WHERE id=?',
                                  (event['item_id'],)).fetchone()
                if item and item['state'] != 'done' and item['error']:
                    active.append({**event, **details, 'queue_state': item['state']})
            elif status.get('run_id') == run_id and status.get('stage') not in ('paused', 'complete'):
                active.append({**event, **details, 'queue_state': 'attention_required'})
        return list(reversed(active))


def notify_unresolved_error(root, run_id, alert, last_notified):
    error = read_json(root / 'latest-error.json')
    if error.get('run_id') != run_id or error.get('id', 0) <= last_notified:
        return alert, last_notified
    try:
        active = active_error_events(root, run_id)
    except (sqlite3.Error, ValueError):
        # Inability to check recovery is not evidence of recovery.
        active = [error]
    new_active = [item for item in active if item.get('id', 0) > last_notified]
    next_seen = error['id']
    already_open = alert is not None and alert.poll() is None
    decision = 'coalesced' if already_open else 'resolved_before_display'
    if new_active and not already_open:
        item = new_active[-1]
        notification = {**item, 'kind': 'error', 'run_id': run_id}
        snapshot = root / 'reports' / f'alert-input-{run_id}-{item["id"]}.json'
        write_json(snapshot, notification)
        alert = spawn(root, 'alert', '--error-path', str(snapshot))
        decision = 'opened'
    write_json(root / 'reports/notification-state.json', {
        'at': now(), 'run_id': run_id, 'latest_seen_event': next_seen,
        'active_error_count': len(active), 'decision': decision})
    # Consume newer events while the existing window updates itself. Do not
    # create a backlog of modal dialogs after the user acknowledges one.
    return alert, next_seen


def alert_conditions(root, report):
    status = read_json(root / 'status.json')
    if report.get('kind') == 'error':
        active = active_error_events(root, report['run_id'])
        if (status.get('run_id') == report['run_id']
                and status.get('stage') == 'attention_required' and not active):
            active = [{'message': status.get('last_error') or report['message'],
                       'queue_state': 'attention_required'}]
        return active
    if (status.get('running') and status.get('stage') != 'attention_required'
            and status.get('run_id') != report.get('run_id')):
        return []
    if report.get('condition') == 'heartbeat_stale':
        try:
            age = (dt.datetime.now(dt.timezone.utc)
                   - dt.datetime.fromisoformat(status['heartbeat_at'])).total_seconds()
            if age < 10:
                return []
        except (KeyError, ValueError):
            pass
    return [report]


def show_alert(root, error_path):
    """One independently running, updating, topmost error window."""
    report = read_json(error_path)
    event_id = str(report.get('id', report.get('run_id', 'unknown')))
    evidence_path = root / 'reports' / ('alert-' + safe_name(event_id) + '.json')
    record = {'at': now(), 'pid': os.getpid(), 'event_id': event_id,
              'run_id': report.get('run_id'), 'state': 'opening', 'visible': False}
    try:
        with exclusive(root / 'alert.lock'):
            run_alert_window(root, report, evidence_path, record)
    except RuntimeError as exc:
        if not str(exc).startswith('This workflow already has an active process:'):
            raise
        write_json(evidence_path, {**record, 'state': 'coalesced_into_existing_window'})


def run_alert_window(root, report, evidence_path, record):
    import tkinter as tk
    from tkinter import ttk
    try:
        initial = alert_conditions(root, report)
    except (sqlite3.Error, ValueError):
        initial = [report]
    if not initial:
        write_json(evidence_path, {**record, 'state': 'resolved_before_display',
                                  'returned_at': now()})
        return
    window = tk.Tk()
    title = 'VIPRPG 下载告警'
    window.title(title)
    window.geometry('740x360')
    window.minsize(650, 320)
    window.attributes('-topmost', True)
    body = ttk.Frame(window, padding=20)
    body.pack(fill='both', expand=True)
    heading = tk.StringVar()
    detail = tk.StringVar()
    label = ttk.Label(body, textvariable=heading, font=('Microsoft YaHei UI', 14, 'bold'))
    label.pack(anchor='w', pady=(0, 12))
    ttk.Label(body, textvariable=detail, wraplength=690, justify='left').pack(anchor='w')
    ttk.Label(body, text='完整文件、断点和错误记录均保留。恢复后本提示自动关闭。',
              wraplength=690).pack(anchor='w', pady=12)
    buttons = ttk.Frame(body)
    buttons.pack(anchor='w', pady=8)
    closing = {'timer': None, 'reason': None}
    def close(reason):
        closing['reason'] = reason
        window.destroy()
    ttk.Button(buttons, text='知道了，关闭提示', command=lambda: close('acknowledged')).pack(side='left')
    ttk.Button(buttons, text='打开日志', command=lambda: os.startfile(root / 'logs')).pack(side='left', padx=12)
    window.protocol('WM_DELETE_WINDOW', lambda: close('acknowledged'))
    user = ctypes.WinDLL('user32', use_last_error=True)
    user.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    user.GetAncestor.restype = wintypes.HWND
    user.GetForegroundWindow.restype = wintypes.HWND
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
    user.GetWindowLongPtrW.restype = ctypes.c_ssize_t
    def finish_recovery():
        closing['timer'] = None
        try:
            if not alert_conditions(root, report):
                close('resolved')
        except (sqlite3.Error, ValueError):
            pass
    def refresh():
        try:
            active = alert_conditions(root, report)
        except (sqlite3.Error, ValueError) as exc:
            active = [{'message': '暂时无法核对恢复状态，告警保留：' + str(exc),
                       'queue_state': 'attention_required'}]
        if active:
            if closing['timer'] is not None:
                window.after_cancel(closing['timer'])
                closing['timer'] = None
            needs_input = any(x.get('queue_state') in ('failed', 'needs_input', 'attention_required') for x in active)
            heading.set(f'下载已中断，{len(active)} 项错误需要处理' if needs_input else f'{len(active)} 项错误等待处理')
            label.configure(foreground='#a52222')
            message = '\n\n'.join(str(x.get('message', 'Unknown error'))[:430] for x in active[-3:])
            incident = active[-1].get('incident_directory') or report.get('incident_directory') or read_json(root / 'status.json').get('incident_directory')
            if incident:
                message += '\n\n排查资料：' + str(incident)
            detail.set(message)
            state = 'visible'
        else:
            heading.set('已自动恢复，下载继续进行')
            label.configure(foreground='#187547')
            detail.set('这些错误对应的项目已恢复。本提示将在 2 秒后自动关闭；历史错误仍保留在日志中。')
            state = 'resolution_pending'
            if closing['timer'] is None:
                closing['timer'] = window.after(2000, finish_recovery)
        window.update_idletasks()
        handle = user.GetAncestor(window.winfo_id(), 2)
        record.update({'title': title, 'window_id': int(handle),
                       'visible': bool(user.IsWindowVisible(handle)),
                       'topmost': bool(user.GetWindowLongPtrW(handle, -20) & 0x8),
                       'foreground': user.GetForegroundWindow() == handle,
                       'active_error_count': len(active),
                       'max_event_id_displayed': max([x.get('id', 0) for x in active] or [0])})
        write_json(evidence_path, {**record, 'state': state, 'observed_at': now()})
        window.after(500, refresh)
    window.update_idletasks()
    window.lift()
    window.focus_force()
    window.bell()
    window.after(100, refresh)
    window.mainloop()
    write_json(evidence_path, {**record, 'state': closing['reason'] or 'closed',
                              'visible': False, 'returned_at': now()})


def supervise(root):
    with exclusive(root / 'supervisor.lock'):
        run_id = uuid.uuid4().hex
        started = now()
        stdout = root / 'logs' / (run_id + '.stdout.log')
        stderr = root / 'logs' / (run_id + '.stderr.log')
        alert, last_notified, stall_notified = None, 0, False
        child = None
        try:
            ensure_proxy(root)
            # Store the exact executed source bytes, with no digest computation.
            snapshot = root / 'reports' / (run_id + '.source.py')
            shutil.copyfile(__file__, snapshot)
            with stdout.open('ab') as output, stderr.open('ab') as error:
                child = subprocess.Popen([sys.executable, '-X', 'faulthandler', str(Path(__file__).resolve()),
                                          '--root', str(root), 'worker', '--run-id', run_id],
                                         creationflags=NO_WINDOW, stdin=subprocess.DEVNULL,
                                         stdout=output, stderr=error, close_fds=True)
            launch = {'run_id': run_id, 'supervisor_pid': os.getpid(), 'worker_pid': child.pid,
                      'started_at': started, 'stdout': str(stdout), 'stderr': str(stderr),
                      'source_snapshot': str(snapshot), 'running': True}
            write_json(root / 'launch.json', launch)
            while child.poll() is None:
                write_json(root / 'supervisor.json', {**launch, 'heartbeat_at': now()})
                status = read_json(root / 'status.json')
                alert, last_notified = notify_unresolved_error(root, run_id, alert, last_notified)
                if status.get('run_id') == run_id:
                    stamp = status.get('heartbeat_at', started)
                    age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(stamp)).total_seconds()
                    if age > 20:
                        raise RuntimeError('工作进程仍存活，但心跳超过 20 秒未更新；停止下载并保留现场。')
                time.sleep(1)
            status = read_json(root / 'status.json')
            normal = status.get('run_id') == run_id and status.get('stage') in ('complete', 'paused') and child.returncode == 0
            exit_record = {**launch, 'at': now(), 'exit_code': child.returncode, 'running': False,
                           'normal_exit': normal, 'terminal_stage': status.get('stage')}
            write_json(root / 'reports' / (run_id + '.exit.json'), exit_record)
            write_json(root / 'supervisor.json', {**exit_record, 'heartbeat_at': now()})
            if not normal:
                recorded_error = read_json(root / 'latest-error.json')
                message = f'下载进程已停止，退出码 {child.returncode}。最后状态：{status.get("stage", "unknown")}。'
                if recorded_error.get('run_id') == run_id:
                    message += '\n' + recorded_error.get('message', '')
                if status.get('run_id') != run_id or status.get('running', True):
                    write_json(root / 'status.json', {**status, 'run_id': run_id, 'running': False,
                        'stage': 'attention_required', 'last_error': message, 'heartbeat_at': now()})
                issue = root / 'reports' / (run_id + '.exit-error.json')
                incident = status.get('incident_directory')
                if not incident:
                    incident = str(incident_snapshot(root, {'run_id': run_id,
                        'failure_kind': 'unexpected_worker_exit', 'message': message,
                        'worker_pid': child.pid, 'exit_code': child.returncode}))
                write_json(issue, {'run_id': run_id, 'message': message, 'incident_directory': incident})
                if alert is None or alert.poll() is not None:
                    spawn(root, 'alert', '--error-path', str(issue))
        except BaseException as exc:
            traceback.print_exc()
            if child is not None and child.poll() is None:
                (root / 'stop.request').write_text(now(), encoding='utf-8')
                try:
                    child.wait(timeout=50)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    child.wait(timeout=10)
            issue = root / 'reports' / (run_id + '.supervisor-error.json')
            report = {'run_id': run_id, 'failure_kind': 'supervisor_exception',
                      'message': '下载监控失败，下载已中断：' + str(exc),
                      'traceback': traceback.format_exc()}
            try:
                report['incident_directory'] = str(incident_snapshot(root, report))
            except Exception:
                traceback.print_exc()
            status = read_json(root / 'status.json')
            write_json(root / 'status.json', {**status, 'run_id': run_id,
                'stage': 'attention_required', 'running': False, 'last_error': report['message'],
                'incident_directory': report.get('incident_directory'), 'heartbeat_at': now()})
            write_json(issue, report)
            spawn(root, 'alert', '--error-path', str(issue))
            return 2
        return 0


def start(root, open_monitor=True):
    initialize(root)
    with exclusive(root / 'start.lock'):
        # Attempting this lock proves whether the previous supervisor is still live.
        with exclusive(root / 'supervisor.lock'):
            if (root / 'stop.request').exists():
                (root / 'stop.request').unlink()
        child = spawn(root, 'supervise')
        for _ in range(100):
            if child.poll() is not None:
                raise RuntimeError('Supervisor startup failed; inspect logs/supervise.stderr.log')
            if read_json(root / 'launch.json').get('supervisor_pid') == child.pid:
                break
            time.sleep(.1)
        else:
            raise RuntimeError('Supervisor startup remains pending; inspect its live process before retrying')
        if open_monitor:
            try:
                with exclusive(root / 'monitor.lock'):
                    pass
            except RuntimeError:
                pass
            else:
                spawn(root, 'monitor')
    return {'supervisor_pid': child.pid, 'root': str(root), 'status': 'starting'}


def monitor(root):
    import tkinter as tk
    from tkinter import ttk, messagebox
    with exclusive(root / 'monitor.lock'):
        window = tk.Tk()
        window.title('VIPRPG 本地下载 — 实时进度')
        window.geometry('820x580')
        window.minsize(720, 540)
        window.configure(background='#f4f5f7')
        body = ttk.Frame(window, padding=20)
        body.pack(fill='both', expand=True)
        ttk.Label(body, text='VIPRPG 本地下载', font=('Microsoft YaHei UI', 18, 'bold')).pack(anchor='w')
        status_text = tk.StringVar(value='正在读取状态…')
        ttk.Label(body, textvariable=status_text, font=('Microsoft YaHei UI', 11)).pack(anchor='w', pady=(12, 5))
        counters = tk.StringVar()
        ttk.Label(body, textvariable=counters, font=('Microsoft YaHei UI', 12), justify='left').pack(anchor='w', pady=8)
        active = tk.StringVar()
        ttk.Label(body, textvariable=active, wraplength=760, justify='left').pack(anchor='w', pady=8)
        progress = ttk.Progressbar(body, maximum=100)
        progress.pack(fill='x', pady=6)
        speed = tk.StringVar()
        ttk.Label(body, textvariable=speed).pack(anchor='w')
        error_text = tk.StringVar()
        error_label = ttk.Label(body, textvariable=error_text, foreground='#a52222', wraplength=760,
                                justify='left')
        error_label.pack(anchor='w', pady=12)
        buttons = ttk.Frame(body)
        buttons.pack(anchor='w', pady=8)
        def pause():
            (root / 'stop.request').write_text(now(), encoding='utf-8')
        def resume():
            try:
                start(root, open_monitor=False)
            except Exception as exc:
                messagebox.showerror('无法继续', str(exc), parent=window)
        ttk.Button(buttons, text='暂停并保留断点', command=pause).pack(side='left', padx=(0, 8))
        ttk.Button(buttons, text='继续下载', command=resume).pack(side='left', padx=8)
        ttk.Button(buttons, text='打开保存目录', command=lambda: os.startfile(root / 'files')).pack(side='left', padx=8)
        ttk.Button(buttons, text='打开日志', command=lambda: os.startfile(root / 'logs')).pack(side='left', padx=8)
        ttk.Label(body, text=str(root) + '\n关闭此窗口后下载和独立出错告警继续运行。',
                  foreground='#666666', wraplength=760).pack(anchor='w', pady=10)
        names = {'starting': '正在启动', 'reading_page': '读取来源页面', 'source_countdown': '等待源站下载倒计时',
                 'downloading': '正在下载', 'validating': '检查文件长度及压缩包 CRC', 'retry_wait': '等待重试',
                 'rate_limit_wait': '遵循源站限流等待', 'paused': '已暂停', 'complete': '当前队列完成',
                 'collecting_diagnostics': '已中断下载，正在保存排查资料',
                 'attention_required': '下载已中断，需要处理'}
        def refresh():
            record = read_json(root / 'status.json')
            stage = record.get('stage', 'starting')
            age = 0
            try:
                age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(record['heartbeat_at'])).total_seconds()
            except (KeyError, ValueError):
                pass
            status_text.set(names.get(stage, stage) + f'　·　心跳 {age:.0f} 秒前　·　日本独立出口')
            counts = record.get('counts', {})
            pages = record.get('page_counts', {})
            counters.set(f"已保存 {counts.get('done', 0)} 个文件　/　已发现 {sum(counts.values())} 个候选\n"
                         f"连续成功 {record.get('consecutive_success', 0)} / 50　　真正错误 {record.get('run_errors', 0)}\n"
                         f"自动重试 {record.get('retry_attempts', 0)} 次　　已恢复 {record.get('recovered_retries', 0)} 项\n"
                         f"已保存 {record.get('completed_bytes', 0) / GIB:.2f} GiB　　磁盘空闲 {record.get('free_bytes', 0) / GIB:.1f} GiB\n"
                         f"已列举 {pages.get('done', 0)} 页　　待处理错误 {counts.get('failed', 0) + counts.get('needs_input', 0)} 项")
            active.set(record.get('active_item', '') + '\n' + record.get('active_filename', ''))
            total, done = record.get('file_total', 0), record.get('file_bytes', 0)
            progress['value'] = min(100, done / total * 100) if total else 0
            speed.set(f"当前文件 {done / 1048576:.2f} / {total / 1048576:.2f} MiB　　{record.get('speed_bps', 0) / 1048576:.2f} MiB/s")
            try:
                active_errors = active_error_events(root, record['run_id']) if record.get('run_id') else []
                if active_errors:
                    error_text.set(f'当前 {len(active_errors)} 项错误：' + active_errors[-1]['message'][:260])
                    error_label.configure(foreground='#a52222')
                else:
                    error_text.set(f"历史错误 {record.get('run_errors', 0)} 次；当前没有待处理错误。")
                    error_label.configure(foreground='#187547')
            except (sqlite3.Error, ValueError):
                error_text.set('暂时无法读取错误状态；请保留日志并检查监控。')
                error_label.configure(foreground='#a52222')
            write_json(root / 'reports/monitor.json', {'at': now(), 'pid': os.getpid(), 'window_id': window.winfo_id(),
                'visible': bool(window.winfo_viewable()), 'run_id': record.get('run_id'), 'displayed_stage': stage,
                'displayed_done': counts.get('done', 0), 'displayed_streak': record.get('consecutive_success', 0)})
            window.after(1000, refresh)
        window.after(100, refresh)
        window.mainloop()


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    actions = parser.add_subparsers(dest='action', required=True)
    actions.add_parser('init')
    actions.add_parser('start')
    actions.add_parser('supervise')
    actions.add_parser('monitor')
    actions.add_parser('status')
    actions.add_parser('pause')
    worker = actions.add_parser('worker')
    worker.add_argument('--run-id', required=True)
    alert = actions.add_parser('alert')
    alert.add_argument('--error-path', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if args.action == 'init':
        print(json.dumps(initialize(root), ensure_ascii=False))
    elif args.action == 'start':
        print(json.dumps(start(root), ensure_ascii=False))
    elif args.action == 'supervise':
        return supervise(root)
    elif args.action == 'worker':
        with exclusive(root / 'worker.lock'):
            return Worker(root, args.run_id).run()
    elif args.action == 'monitor':
        monitor(root)
    elif args.action == 'status':
        print(json.dumps(read_json(root / 'status.json'), ensure_ascii=False, indent=2))
    elif args.action == 'pause':
        (root / 'stop.request').write_text(now(), encoding='utf-8')
        print('Pause requested; waiting for the current operation to checkpoint.')
    elif args.action == 'alert':
        show_alert(root, args.error_path)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
