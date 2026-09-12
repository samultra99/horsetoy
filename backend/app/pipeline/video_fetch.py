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
    is done editing. video_id/source_url are stored on the Slot precisely so
    the render step can re-resolve and download the full-res version of the
    exact same video via fetch_by_video_id — no re-searching, so there's no
    risk of a different video coming back than the one the user reviewed.

fetch_by_video_id (used by the export step, see routes_render.py) never
touches the Slot's own local_path/quality — the editing preview stays on
the cheap 360p file throughout; the 1080p file is fetched into a separate
cache entry and only ever handed to the renderer for the one export run.

Downloads are capped to the first MAX_DOWNLOAD_SECONDS of the source video
via yt-dlp's download_ranges — we only ever need a few seconds per slot, so
pulling a full (sometimes multi-GB, multi-hour) source video is pure waste.
The cap leaves headroom beyond a typical slot duration so trim-window
adjustments still have material to work with, and since both quality tiers
of a given video share that same cap, a trim window picked against the
360p preview stays valid against the 1080p re-fetch.
"""

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

import yt_dlp

from app.config import CLIPS_CACHE_DIR

BLOCKED_MARKERS = ("429", "too many requests", "blocked", "captcha", "sign in to confirm")
MAX_DOWNLOAD_SECONDS = 30.0

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
    def fetch_by_video_id(self, video_id: str, source_url: str, quality: Quality) -> FetchResult: ...


class YtDlpFetcher:
    """VideoFetcher backed by yt-dlp's ytsearchN: pseudo-URL, no official API."""

    def _download(self, cache_key: str, source_url: str, quality: Quality) -> tuple[str, str]:
        """Downloads (or reuses a cached copy of) source_url at the given
        quality, keyed by cache_key. Returns (video_id, local_path); the
        caller already knows video_id, this just does the fetch/cache dance.
        """
        existing = list(CLIPS_CACHE_DIR.glob(f"{cache_key}.*"))
        if existing:
            return str(existing[0])

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
        return local_path

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
        local_path = self._download(cache_key, source_url, quality)

        return FetchResult(
            video_id=video_id,
            source_url=source_url,
            local_path=local_path,
            duration=_probe_duration(local_path),
            quality=quality,
        )

    def fetch_by_video_id(self, video_id: str, source_url: str, quality: Quality) -> FetchResult:
        """Re-resolves a specific, already-known video (rather than a fresh
        search) at the given quality. This is what the export step uses to
        swap the 360p editing preview for a 1080p source without risking a
        different video coming back from a re-run search.
        """
        cache_key = f"{video_id}-{quality}"
        local_path = self._download(cache_key, source_url, quality)

        return FetchResult(
            video_id=video_id,
            source_url=source_url,
            local_path=local_path,
            duration=_probe_duration(local_path),
            quality=quality,
        )
