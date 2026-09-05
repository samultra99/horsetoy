"""Per-noun speech timing prediction via edge-tts.

edge-tts synthesizes the paragraph with a real neural voice and streams
`WordBoundary` events carrying each spoken word's exact start time — no
separate forced-alignment step is needed. We align those TTS word events
back onto the source text's character offsets (edge-tts doesn't report
character offsets itself, only spoken order), then look up the first
aligned offset falling inside each noun's character span to get its
spoken timestamp.

Synthesized audio + word timestamps are cached to disk keyed by a hash of
(text, voice) so repeat requests for an unchanged paragraph don't re-hit
the network.
"""

import hashlib
import json
import re
from dataclasses import dataclass

import edge_tts

from app.config import NARRATION_CACHE_DIR
from app.pipeline.noun_extraction import NounRecord

DEFAULT_VOICE = "en-US-AriaNeural"
TOKEN_RE = re.compile(r"[A-Za-z0-9']+")
ALIGNMENT_LOOKAHEAD = 5


@dataclass
class TimingResult:
    narration_audio_path: str
    word_timestamps: list[dict]  # [{"word": str, "start": float}]
    noun_timings: dict[str, float | None]  # noun.id -> start seconds (None if unmatched)
    total_duration: float


def _cache_key(text: str, voice: str) -> str:
    return hashlib.sha256(f"{voice}::{text}".encode()).hexdigest()


def _norm(word: str) -> str:
    return re.sub(r"[^a-z0-9]", "", word.lower())


def _tokenize_with_offsets(text: str) -> list[tuple[str, int]]:
    return [(m.group(0), m.start()) for m in TOKEN_RE.finditer(text)]


def _align_words_to_source(
    source_tokens: list[tuple[str, int]], tts_words: list[dict]
) -> list[tuple[int, float]]:
    """Returns [(source_char_start, tts_start_seconds), ...] in spoken order."""
    aligned: list[tuple[int, float]] = []
    src_i = 0
    for w in tts_words:
        target = _norm(w["word"])
        if not target:
            continue
        for offset in range(ALIGNMENT_LOOKAHEAD):
            j = src_i + offset
            if j >= len(source_tokens):
                break
            cand_word, cand_char = source_tokens[j]
            cand_norm = _norm(cand_word)
            if cand_norm and (
                cand_norm == target or cand_norm.startswith(target) or target.startswith(cand_norm)
            ):
                aligned.append((cand_char, w["start"]))
                src_i = j + 1
                break
    return aligned


async def _synthesize(text: str, voice: str) -> tuple[bytes, list[dict]]:
    communicate = edge_tts.Communicate(text, voice, boundary="WordBoundary")
    audio_chunks: list[bytes] = []
    words: list[dict] = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            words.append({"word": chunk["text"], "start": chunk["offset"] / 1e7})
    return b"".join(audio_chunks), words


async def synthesize_and_align(
    text: str, nouns: list[NounRecord], voice: str = DEFAULT_VOICE
) -> TimingResult:
    key = _cache_key(text, voice)
    audio_path = NARRATION_CACHE_DIR / f"{key}.mp3"
    meta_path = NARRATION_CACHE_DIR / f"{key}.json"

    if audio_path.exists() and meta_path.exists():
        tts_words = json.loads(meta_path.read_text())
    else:
        audio_bytes, tts_words = await _synthesize(text, voice)
        audio_path.write_bytes(audio_bytes)
        meta_path.write_text(json.dumps(tts_words))

    source_tokens = _tokenize_with_offsets(text)
    aligned = _align_words_to_source(source_tokens, tts_words)
    aligned.sort(key=lambda pair: pair[0])

    noun_timings: dict[str, float | None] = {}
    for noun in nouns:
        in_span = [t for c, t in aligned if noun.char_start <= c < noun.char_end]
        if in_span:
            noun_timings[noun.id] = min(in_span)
            continue
        preceding = [t for c, t in aligned if c <= noun.char_start]
        noun_timings[noun.id] = preceding[-1] if preceding else None

    total_duration = max((w["start"] for w in tts_words), default=0.0)

    return TimingResult(
        narration_audio_path=str(audio_path),
        word_timestamps=[{"word": w["word"], "start": w["start"]} for w in tts_words],
        noun_timings=noun_timings,
        total_duration=total_duration,
    )
