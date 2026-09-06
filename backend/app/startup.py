"""Startup-time maintenance tasks."""

import asyncio
import sys

import yt_dlp


async def check_yt_dlp_update() -> None:
    """Upgrades yt-dlp in the background on every server start.

    yt-dlp ships very frequent releases to keep up with YouTube's changing
    player/signature logic (see the fragility risk noted in PLAN.md) — an
    install that's even a few weeks stale can simply stop being able to
    fetch anything. Runs as a background task so it never delays server
    startup; failures (e.g. no network) are printed, not raised. Uses print
    rather than logging since a bare `logging.getLogger` here wouldn't be
    at a visible level under uvicorn's default logging config.
    """
    before = yt_dlp.version.__version__
    print(f"[startup] checking for yt-dlp updates (currently {before})...", flush=True)
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "pip",
            "install",
            "-q",
            "-U",
            "yt-dlp",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode == 0:
            print(
                "[startup] yt-dlp update check completed (restart to pick up a new version if installed)",
                flush=True,
            )
        else:
            reason = stderr.decode(errors="ignore").strip()
            print(f"[startup] yt-dlp update check failed: {reason}", flush=True)
    except Exception as e:  # noqa: BLE001 - best-effort background maintenance
        print(f"[startup] yt-dlp update check failed: {e}", flush=True)
