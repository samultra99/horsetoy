"""Noun + qualifying-word extraction using spaCy (en_core_web_sm).

For each noun occurrence in the source text we produce a NounRecord: the
noun's own (possibly compound) text, plus qualifying words pulled from the
dependency parse (adjectival/gerund modifiers, compound-noun siblings) and,
as a supplement, a small proximity window for words the parse doesn't
connect. Qualifying words are bucketed by the search-template slot type
they can fill (adj / gerund / noun2) so the search-string generator can
weight them over fully random word-bank picks.
"""

from dataclasses import dataclass, field
from functools import lru_cache

import spacy
from spacy.tokens import Doc, Token

PROXIMITY_WINDOW = 3
FALLBACK_POS = {"ADJ", "NOUN", "PROPN", "VERB"}


@dataclass
class NounRecord:
    id: str
    noun_text: str
    pos: str  # "NOUN" or "PROPN"
    char_start: int
    char_end: int
    qualifiers: dict[str, list[str]] = field(default_factory=dict)
    proximity_fallback_words: dict[str, list[str]] = field(default_factory=dict)


@lru_cache(maxsize=1)
def _nlp():
    return spacy.load("en_core_web_sm")


def _slot_bucket_for_token(token: Token) -> str | None:
    """Classify a modifier/nearby token into a search-template slot type."""
    if token.tag_ == "VBG" or (token.pos_ == "VERB" and token.text.lower().endswith("ing")):
        return "gerund"
    if token.pos_ == "ADJ":
        return "adj"
    if token.pos_ in ("NOUN", "PROPN"):
        return "noun2"
    return None


def _add_word(bucket_dict: dict[str, list[str]], slot: str, word: str) -> None:
    words = bucket_dict.setdefault(slot, [])
    if word.lower() not in (w.lower() for w in words):
        words.append(word)


def extract_nouns(text: str) -> list[NounRecord]:
    doc: Doc = _nlp()(text)
    chunks = [c for c in doc.noun_chunks if c.root.pos_ in ("NOUN", "PROPN")]

    # First pass: figure out which tokens are already "claimed" as a
    # dependency modifier (amod/compound) of some noun in the document, so
    # the proximity-window fallback for a *different* nearby noun doesn't
    # also pick them up (e.g. "heavy" modifying "staff" shouldn't leak into
    # a nearby "wizard"'s fallback pool just because it's within range).
    claimed_modifier_idxs: set[int] = set()
    for chunk in chunks:
        root = chunk.root
        for c in root.children:
            if c.dep_ in ("amod", "compound"):
                claimed_modifier_idxs.add(c.i)

    records: list[NounRecord] = []
    for idx, chunk in enumerate(chunks):
        root = chunk.root

        compound_children = sorted(
            (c for c in root.children if c.dep_ == "compound"), key=lambda t: t.i
        )
        noun_tokens = sorted(compound_children + [root], key=lambda t: t.i)
        noun_text = " ".join(t.text for t in noun_tokens).lower()
        char_start = noun_tokens[0].idx
        char_end = noun_tokens[-1].idx + len(noun_tokens[-1].text)

        qualifiers: dict[str, list[str]] = {}
        amod_children = [c for c in root.children if c.dep_ == "amod"]
        for child in amod_children:
            slot = _slot_bucket_for_token(child)
            if slot:
                _add_word(qualifiers, slot, child.text.lower())

        noun_token_idxs = {t.i for t in noun_tokens}
        proximity_fallback: dict[str, list[str]] = {}
        window_start = max(0, noun_tokens[0].i - PROXIMITY_WINDOW)
        window_end = min(len(doc), noun_tokens[-1].i + PROXIMITY_WINDOW + 1)
        for tok in doc[window_start:window_end]:
            if tok.i in noun_token_idxs or tok in amod_children:
                continue
            if tok.i in claimed_modifier_idxs:
                continue
            if tok.is_stop or not tok.is_alpha or tok.pos_ not in FALLBACK_POS:
                continue
            slot = _slot_bucket_for_token(tok)
            if slot:
                _add_word(proximity_fallback, slot, tok.text.lower())

        records.append(
            NounRecord(
                id=f"n{idx}",
                noun_text=noun_text,
                pos=root.pos_,
                char_start=char_start,
                char_end=char_end,
                qualifiers=qualifiers,
                proximity_fallback_words=proximity_fallback,
            )
        )

    return records
