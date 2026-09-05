"""Loads and validates the search-string template bank and word banks."""

import json
import re
from dataclasses import dataclass
from functools import lru_cache

from app.config import DATA_DIR

PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")

# Placeholder types that can be filled from the source text's noun
# qualifiers/proximity words rather than only the random word banks.
QUALIFIER_FILLABLE_SLOTS = {"adj", "gerund", "noun2"}


@dataclass(frozen=True)
class SearchTemplate:
    id: str
    category: str
    template: str
    slots: tuple[str, ...]  # placeholder names found in the template, excluding "noun"


@lru_cache(maxsize=1)
def load_templates() -> list[SearchTemplate]:
    raw = json.loads((DATA_DIR / "search_templates.json").read_text())
    templates = []
    seen_ids = set()
    for entry in raw:
        placeholders = tuple(
            name for name in PLACEHOLDER_RE.findall(entry["template"]) if name != "noun"
        )
        if entry["id"] in seen_ids:
            raise ValueError(f"Duplicate template id: {entry['id']}")
        seen_ids.add(entry["id"])
        if "{noun}" not in entry["template"]:
            raise ValueError(f"Template {entry['id']} does not reference {{noun}}")
        templates.append(
            SearchTemplate(
                id=entry["id"],
                category=entry["category"],
                template=entry["template"],
                slots=placeholders,
            )
        )
    return templates


@lru_cache(maxsize=1)
def load_word_banks() -> dict[str, list[str]]:
    return json.loads((DATA_DIR / "word_banks.json").read_text())
