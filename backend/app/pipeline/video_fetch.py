"""Video sourcing via yt-dlp: search + download, one clip at a time.

Fetching is always lazy and explicit — this module never pre-fetches
alternates or speculative candidates. Each call resolves exactly the
requested rank of a single query to a downloaded local file, reusing an
already-downloaded file for the same (query, video_id, quality) if present.

Two quality tiers:
  - "preview" (360p): what the editor works with while the user is still
    editing — cheap to fetch, plenty for on-screen preview and export
    smoke-testing.
  - "full" (1080p): the resolution used for the final export once the user
    is done editing. Re-fetching by (video_id, quality) is what "systematic
    storage of the clip link" is for — video_id/source_url are stored on
    the Slot so a later milestone can re-resolve and download the full-res
    version of the exact same video without re-searching.

The preview/full swap-at-export-time flow itself is a later milestone —
this module only makes the two quality tiers fetchable; nothing currently
calls fetch_by_rank with quality="full".

Downloads are capped to the first MAX_DOWNLOAD_SECONDS of the source video
via yt-dlp's download_ranges — we only ever need a few seconds per slot, so
pulling a full (sometimes multi-GB, multi-hour) source video is pure waste.
The cap leaves headroom beyond a typical slot duration so a later
trim-window adjustment (M4) still has material to work with. (When the
future full-quality re-fetch lands, it should likely narrow this to the
slot's actual trim window instead of a blanket cap — noted for then.)
"""

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

import yt_dlp

from app.config import CLIPS_CACHE_DIR

BLOCKED_MARKERS = ("429", "too many requests", "blocked", "captcha", "sign in to confirm")
MAX_DOWNLOAD_SECONDS = 90.0

Quality = Literal["preview", "full"]
QUALITY_MAX_HEIGHT: dict[Quality, int] = {"preview": 360, "full": 1080}


@dataclass
class FetchResult:
    video_id: str
    source_url: str
    local_path: str
    duration: float
    quality: Quality


class VideoFetchError(Exception):
    def __init__(self, message: str, blocked: bool = False):
        super().__init__(message)
        self.blocked = blocked


def _looks_blocked(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in BLOCKED_MARKERS)


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:80] or "query"


def _probe_duration(path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True,
        text=True,
    )
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0


def _capped_range_selector(info_dict: dict, _ydl: object):
    source_duration = info_dict.get("duration")
    end = min(MAX_DOWNLOAD_SECONDS, source_duration) if source_duration else MAX_DOWNLOAD_SECONDS
    yield {"start_time": 0, "end_time": end}


class VideoFetcher(Protocol):
    def fetch_by_rank(self, query: str, rank: int, quality: Quality) -> FetchResult: ...


class YtDlpFetcher:
    """VideoFetcher backed by yt-dlp's ytsearchN: pseudo-URL, no official API."""

    def fetch_by_rank(self, query: str, rank: int = 1, quality: Quality = "preview") -> FetchResult:
        search_opts = {"quiet": True, "no_warnings": True, "noplaylist": True}
        try:
            with yt_dlp.YoutubeDL(search_opts) as ydl:
                info = ydl.extract_info(f"ytsearch{rank}:{query}", download=False)
        except yt_dlp.utils.DownloadError as e:
            raise VideoFetchError(str(e), blocked=_looks_blocked(str(e))) from e

        entries = [e for e in (info.get("entries") or []) if e]
        if len(entries) < rank:
            raise VideoFetchError(f"No result at rank {rank} for query: {query!r}")
        target = entries[rank - 1]

        video_id = target["id"]
        source_url = target.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}"
        cache_key = f"{_slugify(query)}-{video_id}-{quality}"
        existing = list(CLIPS_CACHE_DIR.glob(f"{cache_key}.*"))
        if existing:
            local_path = str(existing[0])
            return FetchResult(
                video_id=video_id,
                source_url=source_url,
                local_path=local_path,
                duration=_probe_duration(local_path),
                quality=quality,
            )

        max_height = QUALITY_MAX_HEIGHT[quality]
        out_template = str(CLIPS_CACHE_DIR / f"{cache_key}.%(ext)s")
        download_opts = {
            "format": (
                f"bestvideo[height<={max_height}][ext=mp4]+bestaudio[ext=m4a]"
                f"/best[height<={max_height}]/best"
            ),
            "merge_output_format": "mp4",
            "outtmpl": out_template,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "download_ranges": _capped_range_selector,
            "force_keyframes_at_cuts": True,
        }
        try:
            with yt_dlp.YoutubeDL(download_opts) as ydl:
                result = ydl.extract_info(source_url, download=True)
                local_path = ydl.prepare_filename(result)
                if not Path(local_path).exists():
                    # merge_output_format may change the container extension
                    merged = Path(local_path).with_suffix(".mp4")
                    if merged.exists():
                        local_path = str(merged)
        except yt_dlp.utils.DownloadError as e:
            raise VideoFetchError(str(e), blocked=_looks_blocked(str(e))) from e

        return FetchResult(
            video_id=video_id,
            source_url=source_url,
            local_path=local_path,
            duration=_probe_duration(local_path),
            quality=quality,
        )
