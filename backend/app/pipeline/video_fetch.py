"""Video sourcing via yt-dlp: search + download, one clip at a time.

Fetching is always lazy and explicit — this module never pre-fetches
alternates or speculative candidates. Each call resolves exactly the
requested rank of a single query to a downloaded local file, reusing an
already-downloaded file for the same (query, video_id) pair if present.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import yt_dlp

from app.config import CLIPS_CACHE_DIR

BLOCKED_MARKERS = ("429", "too many requests", "blocked", "captcha", "sign in to confirm")


@dataclass
class FetchResult:
    video_id: str
    source_url: str
    local_path: str
    duration: float


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


class VideoFetcher(Protocol):
    def fetch_by_rank(self, query: str, rank: int) -> FetchResult: ...


class YtDlpFetcher:
    """VideoFetcher backed by yt-dlp's ytsearchN: pseudo-URL, no official API."""

    def fetch_by_rank(self, query: str, rank: int = 1) -> FetchResult:
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
        cache_key = f"{_slugify(query)}-{video_id}"
        existing = list(CLIPS_CACHE_DIR.glob(f"{cache_key}.*"))
        if existing:
            return FetchResult(
                video_id=video_id,
                source_url=target.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}",
                local_path=str(existing[0]),
                duration=float(target.get("duration") or 0),
            )

        out_template = str(CLIPS_CACHE_DIR / f"{cache_key}.%(ext)s")
        download_opts = {
            "format": "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]/best",
            "merge_output_format": "mp4",
            "outtmpl": out_template,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
        }
        try:
            with yt_dlp.YoutubeDL(download_opts) as ydl:
                result = ydl.extract_info(target["webpage_url"], download=True)
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
            source_url=target.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}",
            local_path=local_path,
            duration=float(result.get("duration") or 0),
        )
