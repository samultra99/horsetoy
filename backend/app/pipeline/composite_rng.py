"""Random hard-cut-vs-overlay decision per slot.

Each slot after the first rolls independently whether it hard-cuts (starts
a fresh single-clip group) or overlays on top of the current stack. The
chance of continuing to stack decreases as the stack grows, and stacking
is capped at MAX_LAYERS so it always eventually resets to a single clip —
matching the spec's "sometimes two or three clips stack before a new clip
appears alone."

This assignment happens once, at timeline-build time, same as noun timing.
Two narrower operations touch one slot's choice after the fact, both
scoped the same way (only that slot's own composite fields, no downstream
cascade): reroll_slot re-rolls it against the RNG again, and set_slot_mode
pins it to a specific cut/overlay choice the user picked directly.
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
    # A reroll hands the choice back to the RNG, so it's no longer a
    # user-pinned override — clears whatever set_slot_mode last set.
    slot.composite.locked = False


class CompositeEditError(Exception):
    pass


def set_slot_mode(slots: list[Slot], slot_id: str, mode: str) -> None:
    """Manually pins a slot's cut/overlay choice (the editable counterpart
    to reroll_slot's random one). Same "no downstream cascade" contract as
    reroll_slot — only the edited slot's own composite fields are touched.
    """
    if mode not in ("cut", "overlay"):
        raise CompositeEditError(f"invalid mode: {mode!r}")

    index = next((i for i, s in enumerate(slots) if s.id == slot_id), None)
    if index is None:
        raise CompositeEditError("slot not found")

    slot = slots[index]

    if mode == "cut":
        slot.composite.mode = "cut"
        slot.composite.layer = 0
        slot.composite.overlay_of = []
        # Length/fades only mean anything for an overlay; drop them so a
        # later re-stack starts from the default "covers the whole stack"
        # rather than silently reusing a length from a previous edit.
        slot.composite.duration = None
        slot.composite.fade_in = 0.0
        slot.composite.fade_out = 0.0
        slot.composite.locked = True
        return

    if index == 0:
        raise CompositeEditError("the first clip can't stack onto anything before it")

    prev = slots[index - 1]
    prev_layer = prev.composite.layer if prev.composite.mode == "overlay" else 0
    if prev_layer + 1 >= MAX_LAYERS:
        raise CompositeEditError(f"that stack is already at the maximum of {MAX_LAYERS} layers")

    slot.composite.mode = "overlay"
    slot.composite.layer = prev_layer + 1
    slot.composite.overlay_of = list(prev.composite.overlay_of) + [prev.id]
    slot.composite.locked = True
