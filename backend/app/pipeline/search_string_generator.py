"""Generates candidate YouTube search strings for a noun.

Each candidate draws a random template from the 100-template bank and fills
its non-`{noun}` slots by weighted choice: with probability QUALIFIER_WEIGHT,
pull from words that already qualify the noun in the source text (dependency
modifiers, then proximity-window fallback); otherwise draw a fully random
word from the curated word bank. Slot types with no textual analogue in the
source (location/emotion/era/genre) always draw from the word bank.
"""

import random

from app.pipeline.noun_extraction import NounRecord
from app.pipeline.search_templates import SearchTemplate, load_templates, load_word_banks

QUALIFIER_WEIGHT = 0.7
DEFAULT_CANDIDATE_COUNT = 10


def _fill_slot(slot: str, noun: NounRecord, rng: random.Random, word_banks: dict[str, list[str]]) -> str:
    pool = noun.qualifiers.get(slot, []) + [
        w for w in noun.proximity_fallback_words.get(slot, []) if w not in noun.qualifiers.get(slot, [])
    ]
    if pool and rng.random() < QUALIFIER_WEIGHT:
        return rng.choice(pool)
    bank = word_banks.get(slot, [])
    if bank:
        return rng.choice(bank)
    if pool:
        return rng.choice(pool)
    return slot  # last-resort: should not happen with a well-formed word bank


def _render(template: SearchTemplate, noun: NounRecord, rng: random.Random, word_banks: dict[str, list[str]]) -> str:
    fill = {"noun": noun.noun_text}
    for slot in template.slots:
        fill[slot] = _fill_slot(slot, noun, rng, word_banks)
    return template.template.format(**fill)


def generate_candidates(
    noun: NounRecord,
    count: int = DEFAULT_CANDIDATE_COUNT,
    exclude_template_ids: set[str] | None = None,
    rng: random.Random | None = None,
) -> list[dict[str, str]]:
    rng = rng or random.Random()
    templates = load_templates()
    word_banks = load_word_banks()
    exclude_template_ids = exclude_template_ids or set()

    available = [t for t in templates if t.id not in exclude_template_ids]
    pool = available if len(available) >= count else templates
    chosen = rng.sample(pool, k=min(count, len(pool)))

    return [
        {"template_id": t.id, "text": _render(t, noun, rng, word_banks)}
        for t in chosen
    ]
