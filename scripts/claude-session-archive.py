#!/usr/bin/env python3
"""Keep append-only Claude transcripts outside Claude Code's retention sweep."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import signal
import time
from pathlib import Path


SOURCE_ROOT = Path.home() / ".claude" / "projects"
DATA_ROOT = Path(os.environ.get("CLOUDCLI_DATA_DIR", Path.home() / ".cloudcli"))
ARCHIVE_ROOT = DATA_ROOT / "claude-session-archive"
TRASH_ROOT = DATA_ROOT / "claude-session-trash"
CCUI_LOG = Path(os.environ.get("CLOUDCLI_LOG_FILE", DATA_ROOT / "server.log"))
DELETE_LOG_OFFSET = ARCHIVE_ROOT / ".delete-log-offset"
DELETE_PATTERN = re.compile(
    r"\[API\] Deleting session: ([0-9a-fA-F-]+) from project: ([A-Za-z0-9._-]+)"
)
STOP = False


def request_stop(_signum: int, _frame: object) -> None:
    global STOP
    STOP = True


def import_delete_tombstones() -> int:
    if not CCUI_LOG.exists():
        return 0
    ARCHIVE_ROOT.mkdir(parents=True, exist_ok=True)
    try:
        offset = int(DELETE_LOG_OFFSET.read_text(encoding="ascii").strip())
    except (FileNotFoundError, ValueError):
        offset = 0
    size = CCUI_LOG.stat().st_size
    if offset > size:
        offset = 0

    imported = 0
    with CCUI_LOG.open("rb") as stream:
        stream.seek(offset)
        for raw_line in stream:
            line = raw_line.decode("utf-8", errors="replace")
            match = DELETE_PATTERN.search(line)
            if not match:
                continue
            session_id, project_name = match.groups()
            tombstone_dir = ARCHIVE_ROOT / project_name / ".deleted"
            tombstone_dir.mkdir(parents=True, exist_ok=True)
            tombstone = tombstone_dir / session_id
            if not tombstone.exists():
                tombstone.write_text(line[:500], encoding="utf-8")
                imported += 1
        offset = stream.tell()
    DELETE_LOG_OFFSET.write_text(str(offset), encoding="ascii")
    return imported


def sync_once() -> tuple[int, int]:
    archived = 0
    restored = 0
    imported = import_delete_tombstones()
    if imported:
        print(f"claude archive delete tombstones imported={imported}", flush=True)
    if not SOURCE_ROOT.is_dir():
        return archived, restored

    ARCHIVE_ROOT.mkdir(parents=True, exist_ok=True)
    project_names = {entry.name for entry in SOURCE_ROOT.iterdir() if entry.is_dir()}
    project_names.update(entry.name for entry in ARCHIVE_ROOT.iterdir() if entry.is_dir())

    for project_name in sorted(project_names):
        source_dir = SOURCE_ROOT / project_name
        archive_dir = ARCHIVE_ROOT / project_name
        tombstone_dir = archive_dir / ".deleted"
        source_dir.mkdir(parents=True, exist_ok=True)
        archive_dir.mkdir(parents=True, exist_ok=True)
        tombstone_dir.mkdir(parents=True, exist_ok=True)

        tombstoned = {entry.name for entry in tombstone_dir.iterdir() if entry.is_file()}
        for session_id in tombstoned:
            source = source_dir / f"{session_id}.jsonl"
            archive = archive_dir / f"{session_id}.jsonl"
            trash_dir = TRASH_ROOT / project_name
            trash = trash_dir / f"{session_id}.jsonl"
            candidates = [entry for entry in (source, archive, trash) if entry.exists()]
            if candidates:
                best = max(candidates, key=lambda entry: entry.stat().st_size)
                if not trash.exists() or best.stat().st_size > trash.stat().st_size:
                    trash_dir.mkdir(parents=True, exist_ok=True)
                    temporary = trash.with_suffix(".jsonl.tmp")
                    shutil.copy2(best, temporary)
                    os.replace(temporary, trash)
            source.unlink(missing_ok=True)
            archive.unlink(missing_ok=True)

        for source in source_dir.glob("*.jsonl"):
            if source.name.startswith("agent-"):
                continue
            if source.stem in tombstoned:
                source.unlink(missing_ok=True)
                continue
            archive = archive_dir / source.name
            source_stat = source.stat()
            archive_stat = archive.stat() if archive.exists() else None
            # Claude transcripts are append-only. Never replace a larger archive
            # with a truncated or partially recovered source file.
            if archive_stat is None or source_stat.st_size > archive_stat.st_size:
                temporary = archive.with_suffix(".jsonl.tmp")
                shutil.copy2(source, temporary)
                os.replace(temporary, archive)
                archived += 1

        for archive in archive_dir.glob("*.jsonl"):
            if archive.stem in tombstoned:
                archive.unlink(missing_ok=True)
                continue
            source = source_dir / archive.name
            if not source.exists():
                temporary = source.with_suffix(".jsonl.tmp")
                shutil.copy2(archive, temporary)
                os.replace(temporary, source)
                restored += 1

    return archived, restored


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    while not STOP:
        archived, restored = sync_once()
        if archived or restored:
            print(f"claude archive sync: archived={archived} restored={restored}", flush=True)
        if args.once:
            break
        time.sleep(max(1.0, args.interval))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
