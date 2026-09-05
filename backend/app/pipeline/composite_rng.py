"""Random hard-cut-vs-overlay decision per slot.

Each slot after the first rolls independently whether it hard-cuts (starts
a fresh single-clip group) or overlays on top of the current stack. The
chance of continuing to stack decreases as the stack grows, and stacking
is capped at MAX_LAYERS so it always eventually resets to a single clip —
matching the spec's "sometimes two or three clips stack before a new clip
appears alone."

This assignment happens once, at timeline-build time, same as noun timing.
Re-rolling one slot's composite choice later (the "regenerate" badge) is a
separate, narrower operation — see reroll_slot in this module — that only
touches that one slot, not the whole downstream stack.
"""

import random

from app.models.project import Slot

MAX_LAYERS = 3
BASE_OVERLAY_PROB = 0.4
DECAY = 0.5


def _overlay_probability(prev_layer: int) -> float:
    if prev_layer + 1 >= MAX_LAYERS:
        return 0.0
    return BASE_OVERLAY_PROB * (DECAY**prev_layer)


def assign_composite_layers(slots: list[Slot], rng: random.Random | None = None) -> None:
    rng = rng or random.Random()
    stack_ids: list[str] = []
    prev_layer = 0

    for i, slot in enumerate(slots):
        if i == 0 or rng.random() >= _overlay_probability(prev_layer):
            slot.composite.mode = "cut"
            slot.composite.layer = 0
            slot.composite.overlay_of = []
            stack_ids = [slot.id]
            prev_layer = 0
        else:
            slot.composite.mode = "overlay"
            slot.composite.layer = prev_layer + 1
            slot.composite.overlay_of = list(stack_ids)
            stack_ids.append(slot.id)
            prev_layer = slot.composite.layer


def reroll_slot(slots: list[Slot], slot_id: str, rng: random.Random | None = None) -> None:
    """Re-rolls a single slot's cut/overlay choice against its immediate
    predecessor's *current* layer. Does not cascade to later slots — if
    that leaves a downstream slot's overlay_of referencing a now-different
    stack shape, it's a minor, accepted v1 quirk rather than something
    worth a full re-simulation of the timeline for.
    """
    rng = rng or random.Random()
    index = next((i for i, s in enumerate(slots) if s.id == slot_id), None)
    if index is None or index == 0:
        return

    prev = slots[index - 1]
    slot = slots[index]
    prev_layer = prev.composite.layer if prev.composite.mode == "overlay" else 0

    if rng.random() >= _overlay_probability(prev_layer):
        slot.composite.mode = "cut"
        slot.composite.layer = 0
        slot.composite.overlay_of = []
    else:
        slot.composite.mode = "overlay"
        slot.composite.layer = prev_layer + 1
        slot.composite.overlay_of = list(prev.composite.overlay_of) + [prev.id]
