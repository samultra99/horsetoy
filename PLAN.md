# HorseToy — Generative Text-to-Video Editor: Implementation Plan

## Context

The goal is a prototype desktop-usable app (run locally) that turns a paragraph of text into an auto-edited vertical video: it extracts nouns from the text, generates YouTube search strings per noun (biased toward words that already qualify that noun in the source text, but with genuine randomness mixed in), fetches a clip per search, and stitches the clips together at the moments a natural speaker would say each noun — with occasional random compositing of multiple clips on top of one another instead of a hard cut. The user can then manually override any of it: swap clips, change the search, adjust crop/zoom/trim, and finally export an MP4.

This is a from-scratch build. Five technical unknowns were researched before committing to an architecture — TTS-based timing prediction, YouTube sourcing legality/reliability, the video compositing pipeline, NLP for noun/qualifier extraction, and the editor's UI state model — and four architecture decisions were confirmed directly with the user (GUI stack, video-source risk tolerance, narration-audio handling, clip-audio handling). Everything below reflects those findings and decisions.

**Environment check (verified on this machine):** Python 3.13.3, ffmpeg 7.1.1, and yt-dlp are already installed. Node v20.12.2 is present, but `npm`/`npx`/`yarn`/`corepack` are **not** — only `pnpm` is available. The plan standardizes on `pnpm` for all frontend tooling to avoid blocking M0. `spacy` and `edge-tts` are not yet installed; they go in `backend/requirements.txt`.

---

## Decisions Locked In

1. **Architecture**: Local web app — Python backend (FastAPI) does all the heavy lifting; a browser-based frontend served from localhost is the editor UI. Not Electron, not a native Qt/PySide app.
2. **Video sourcing**: yt-dlp only, for both search (`ytsearch1:"query"`) and download. No official YouTube Data API — its ~100 free searches/day would be exhausted almost immediately at this app's volume. ToS risk (throttling, not legal exposure, at this scale) accepted. The fetch layer is still built behind a swappable interface so a licensed stock-video backend (Pexels/Pixabay) could replace it later without a rewrite, but only yt-dlp is implemented now. **Downloads are lazy**: only the top result for a slot's currently-active search string is ever fetched, and only when actually needed (populating the editor, or the user explicitly asking for the next result/a new search) — never a batch of candidate clips pre-downloaded speculatively.
3. **Narration audio**: The TTS engine used for timing (edge-tts) is *also* the video's spoken voiceover — its synthesized audio is kept and muxed into the export, with a mute toggle.
4. **Source clip audio**: Kept, not force-muted. Per-clip volume slider + mute toggle. No cross-clip mixing/ducking smarts in v1 (composited clips just `amix` together at whatever volume levels are set) — but the data model (per-clip volume/mute, composite/overlay structure) is designed so real ducking/leveling can be added later without reworking the schema.

---

## Research Findings → Technology Choices

| Concern | Choice | Why |
|---|---|---|
| **Per-noun speech timing** | `edge-tts` (free, MIT, no API key) synthesizes the paragraph and streams `WordBoundary` events with exact per-word offset/duration directly from Microsoft's neural TTS — no separate forced-aligner needed. | Forced aligners (aeneas, MFA, gentle, WhisperX) all require audio to align *against* — none work text-only. edge-tts sidesteps the whole alignment step because it reports its own timing as it synthesizes. Simplest install, best accuracy for this use case. Requires internet at generation time; a documented (not built) fallback is a naive syllable/WPM heuristic (pyphen/CMU-dict + ~150–170wpm + punctuation pause padding) if edge-tts reliability ever becomes an issue. |
| **Video search + download** | `yt-dlp` Python API — `ytsearch1:"<query>"` for the top result only, downloaded **lazily, on demand**. A slot's active search string is only ever resolved to one downloaded clip at a time; no speculative pre-fetching of alternate results or of every one of the ~10 candidate search strings per noun. Escalating to `ytsearchN:` (fetching the *next* ranked result) happens only at the moment the user actually clicks "next video," not ahead of time. | Official YouTube Data API can search but categorically cannot download (ToS-prohibited), and its free quota (~100 search calls/day) can't sustain this app's volume. yt-dlp has no quota wall and better relevance for odd generated queries than any licensed stock library. Downloading only what's actually needed, only when needed, keeps disk usage and request volume to the practical minimum and directly reduces the throttling risk noted below. Real risk: YouTube periodically changes signatures, requiring yt-dlp version updates, and volume can trigger IP throttling — mitigated with randomized delays, version pinning, and distinct "blocked" vs "no result" error handling. |
| **Compositing/crop/trim pipeline** | Raw ffmpeg via subprocess with a hand-built, programmatically generated `filter_complex` graph (crop+scale for 9:16 fill, trim+setpts for in/out windows, overlay chains for stacked layers, amix+volume for audio) — not MoviePy. | MoviePy's per-frame Python compositing and full-timeline re-encode-on-any-change model works against both the dynamic N-way overlay requirement and responsive live preview. A hand-built filter graph runs as one native ffmpeg process (matches raw-ffmpeg performance) and is the only approach that cleanly handles an arbitrary, per-timeline-shape number of overlaid inputs. Low-res proxy transcodes (generated once per downloaded clip) are used for interactive crop/zoom/trim preview; only the final export runs the full graph against full-res originals. |
| **Noun extraction + qualifying words** | spaCy `en_core_web_sm` (~50–80MB, no GPU) — `token.pos_ in {NOUN, PROPN}` plus `doc.noun_chunks` for compound nouns ("coffee cup"), and dependency parsing (`token.children` filtered to `amod`/`compound`, `token.head`) for qualifying words — computed in the same pipeline pass, no extra cost. A ±3-word stopword-filtered proximity window is a fallback/supplement only, for words the dependency parse doesn't connect. | NLTK would need a hand-written regex chunker and external Java tools for real dependency parsing to match this — more assembly for a worse result. spaCy's dependency parse meaningfully outperforms a fixed window (avoids misattributing modifiers across nearby nouns) at no extra install/runtime cost over POS tagging alone. A full LLM call was explicitly ruled out as unnecessary weight for a purely structural (not semantic-reasoning) task. |
| **Editor state model** | A flat ordered list of `Slot` objects (one per noun-triggered insertion point) — not a multi-track graph. Overlap is a `layer` int + `overlay_of: [slot_id]` field on the slot, not real track objects. | Borrowed from OTIO/NLE concepts (separate timeline placement from source trim; layering is a property of placement, not identity) without building actual multi-track machinery, which would be overkill for a prototype. Regenerating a slot's clip (next-video/new-search/manual-search) never reflows other slots' timing — timing is computed once, upstream, and is a separate concern from media selection. |

---

## Architecture

**Frontend**: React + TypeScript + Vite, using **pnpm** (not npm — unavailable in this environment). State managed with **Zustand** — a flat store mirroring the backend's `Slot[]`, with targeted per-slot patch actions (avoids Redux ceremony and Context re-render pain for a list of interactive cards). React is chosen over vanilla/htmx because the UI is fundamentally a stateful, drag-heavy editing surface (draggable crop rect, draggable trim window, many independently-updating slot cards) rather than server-rendered CRUD.

**Backend**: FastAPI — native async endpoints suit yt-dlp/ffmpeg subprocess orchestration, native WebSocket support needs no extra library, and Pydantic models map directly onto the `Slot` schema.

**Communication**: REST for discrete request/response actions (load/save project, patch a slot's trim/crop/volume/composite fields, trigger next-video/new-search/manual-search). A single multiplexed WebSocket (`/ws/progress`) for progress push on long-running jobs (clip fetch, render/export), keyed by `job_id` so the client can route events to the right UI element without one-socket-per-job churn.

### Directory layout

```
backend/
  app/
    main.py                      # FastAPI app, routing, CORS for localhost:5173
    config.py                    # cache dirs, ffmpeg/ffprobe paths, default 9:16
    api/
      routes_project.py          # create/load/save project
      routes_pipeline.py         # POST /analyze (nouns+qualifiers+search strings), POST /timing
      routes_search.py           # next-video / new-search / manual-search (all on-demand fetch)
      routes_render.py           # preview-render (proxy) / export (full-res)
      ws.py                      # /ws/progress connection + pub-sub broadcaster
    pipeline/
      noun_extraction.py         # spaCy: nouns, noun_chunks, dependency-based qualifiers
      search_templates.py        # loads/validates the 100-template bank
      search_string_generator.py # per-noun candidate strings + weighted substitution
      timing_model.py            # edge-tts synth + WordBoundary -> noun timestamp mapping
      video_fetch.py             # VideoFetcher protocol + YtDlpFetcher implementation (lazy fetch)
      proxy.py                   # low-res proxy transcode generation
      filter_graph.py            # ffmpeg filter_complex builder (crop/scale/trim/overlay/amix/volume)
      composite_rng.py           # per-slot hard-cut-vs-overlay roll (escalates back to cut)
    models/
      project.py                 # Project, Slot, Search, Results, Clip, Composite (pydantic)
    state/
      project_store.py           # in-memory project + JSON persistence
      jobs.py                     # job registry, progress pub-sub feeding ws.py
    storage/
      cache_paths.py              # media cache keyed by normalized search string; proxy cache
    tests/
      test_noun_extraction.py
      test_search_string_generator.py
      test_filter_graph.py        # snapshot-tests generated filter_complex strings
      test_timing_model.py        # mocked edge-tts boundary fixtures
  requirements.txt
  data/
    search_templates.json         # ~100 templates, tagged by category/slot-type
    word_banks.json                # adjectives/gerunds/emotions/locations/eras/genres

frontend/
  src/
    App.tsx
    api/client.ts                 # REST wrapper
    api/ws.ts                     # WebSocket hook, job_id-routed event bus
    state/projectStore.ts         # Zustand store mirroring Slot[], targeted patch actions
    components/
      TextInputPanel.tsx
      NounReviewPanel.tsx
      Timeline/TimelineTrack.tsx, SlotCard.tsx, CompositeBadge.tsx
      Preview/VideoPreviewPlayer.tsx, CropZoomOverlay.tsx, TrimWindowSlider.tsx
      SlotControls/NextVideoButton.tsx, NewSearchButton.tsx, ManualSearchInput.tsx
      Audio/NarrationToggle.tsx, ClipVolumeControl.tsx
      ExportPanel.tsx
    hooks/useJobProgress.ts
  package.json / vite.config.ts / tsconfig.json
```

### Slot data shape

```
Slot {
  id, noun, start_time, duration,
  search: { candidates: [str, ...~10], active_index, manual_override: str|null },
  results: { seen_video_ids: [str,...], next_rank_to_try: int },
  clip: { source_url, local_path|null, download_status: "empty"|"pending"|"ready"|"failed",
          trim_start, trim_end, crop_rect, zoom, volume, muted, needs_attention },
  composite: { mode: "cut"|"overlay", layer, overlay_of: [slot_id], locked },
}
```

Note `results` deliberately holds no pre-fetched candidate list — only bookkeeping (`seen_video_ids` to dedupe, `next_rank_to_try` so "next video" knows which `ytsearchN` rank to request) for an on-demand fetch. `clip.local_path` is `null` and `download_status` is `"empty"` until something actually triggers a fetch (initial slot population, or a next-video/new-search/manual-search action) — never populated speculatively ahead of that.

Key invariants: (1) regenerating a slot's `clip`/`search`/`results` never touches `start_time`/`duration` — timing is computed once, upstream, in the timing pass; (2) the hard-cut-vs-overlay roll (`composite_rng.py`) is a separate RNG from clip/search selection, shown as an independently re-rollable badge, so re-rolling structure doesn't force a new video fetch and vice versa; (3) `needs_attention` is set when `clip.duration < slot.duration` (trim window doesn't fit) rather than silently failing; (4) a clip is only ever downloaded once actually needed — not in advance, not speculatively for alternates.

---

## Data Flow (End-to-End)

1. **Text in** → `TextInputPanel` posts the paragraph to `POST /api/pipeline/analyze`.
2. **Noun/qualifier extraction** (`noun_extraction.py`) → per-noun records: `{noun_text, char_offset, qualifiers, proximity_fallback_words}`.
3. **Search string generation** (`search_string_generator.py`) → same `/analyze` response pairs each noun with ~10 candidate search strings, drawn from the 100-template bank with qualifying words weighted in (see below).
4. **Timing prediction** — separate call, `POST /api/pipeline/timing` (split out because it's the network/latency-bound step and may be retried independently) → edge-tts synthesis → `{narration_audio_url, word_timestamps, noun_timings}`.
5. **Timeline construction** — backend merges noun records + search candidates + timing into the canonical `Slot[]`, assigns `duration` from spacing to the next noun's timestamp, persists as the `Project`. This `Slot[]` is the frontend's source of truth.
6. **Initial fetch** (`video_fetch.py`) — once the timeline is built, each slot's *currently active* search string is resolved to its single top (`ytsearch1:`) result and downloaded — one clip per slot, no alternates, no pre-fetching other candidate search strings or other ranked results. Progress streams over `/ws/progress` per slot as these trickle in.
7. **User editing loop** — every control (next-video, new-search, manual-search, trim drag, crop/zoom drag, composite re-roll, volume/mute) is a targeted PATCH scoped to one `slot_id`, returning only that slot's updated sub-object — this is the mechanism enforcing "no reflow" behavior.
8. **Preview render** — crop/zoom/trim edits are debounced, sent to `POST /api/render/preview`, run against proxy media.
9. **Export** — `POST /api/render/export` runs the full filter graph against full-res originals, muxes narration + per-clip audio via `amix`, streams progress, returns a downloadable MP4.

---

## Search String Template Bank

Stored as structured data (`data/search_templates.json`), not hardcoded, so it's editable without code changes. Each entry: `{id, category, template, slots: [slot_type,...]}` with placeholders like `{noun}`, `{adj}`, `{gerund}`, `{noun2}`, `{location}`, `{emotion}`, `{era}`, `{genre}`.

~12–14 categories at ~7–8 templates each to reach 100:
- **Noun + adjective** — `"{adj} {noun}"`, `"{noun} that is {adj}"`
- **Adjective-led** — `"the most {adj} {noun}"`
- **Gerund/verb + noun** — `"{gerund} {noun}"` (e.g. "screaming {noun}")
- **Emotion/reaction** — `"{noun} freakout"`, `"{noun} meltdown"`
- **Location/setting** — `"{noun} in the rain"`, `"{noun} in space"`
- **Genre/format** — `"{noun} tutorial"`, `"{noun} fail compilation"`, `"{noun} asmr"`
- **Sound/onomatopoeia** — `"{noun} noises"`, `"{noun} sound effects"`
- **Intensity/escalation** — `"extreme {noun}"`, `"{noun} gone wrong"`
- **Two-noun combination** (when a qualifier is itself noun-like) — `"{noun} vs {noun2}"`
- **Era/nostalgia** — `"{noun} in the 90s"`, `"vintage {noun}"`
- **Meme/pop-culture** — `"{noun} but it's chaotic"`, `"{noun} compilation"`
- **Plain/trending suffix** — `"{noun} shorts"`, `"{noun} meme"`, `"{noun} edit"`

**Weighted substitution**: for each non-`{noun}` slot, if the noun has a compatible qualifier/proximity word (e.g. an `amod` adjective fills `{adj}`), draw from it with high weight (~70%, a single tunable constant `QUALIFIER_WEIGHT`); otherwise (or on the remaining ~30% even when a qualifier exists — per spec, randomness must still appear) draw from the curated random word bank (`data/word_banks.json`). Slot types with no textual analogue (`{location}`, `{emotion}`, `{era}`, `{genre}`) always draw from the word banks. "Generate more" beyond the initial 10 re-samples additional templates (excluding already-used ids where possible) rather than re-running the whole pipeline.

---

## Phased Milestones

Each milestone is independently demoable and builds strictly on the previous one's data model.

- **M0 — Scaffolding**: FastAPI skeleton + health check; React/Vite/TS skeleton via pnpm hitting it; `.claude/launch.json` for both dev servers. *Done when*: both dev servers run and the frontend shows "backend connected."
- **M1 — Text → timing pipeline (no video)**: `noun_extraction.py`, `search_string_generator.py` + data files, `timing_model.py`, `/analyze` + `/timing` routes; frontend text input + a bare timeline showing noun markers, playing narration audio with markers lighting up in sync. *Done when*: paste a paragraph → see nouns with timestamps → hear TTS narration with correctly-aligned markers.
- **M2 — Search & download**: `video_fetch.py` (`VideoFetcher` protocol + `YtDlpFetcher`), query-keyed media cache, job/WS progress plumbing. Fetch is lazy and minimal: building the timeline triggers exactly one `ytsearch1:` download per slot (its active search string's top result) — no alternate results, no other candidate search strings pre-fetched. *Done when*: constructing a timeline results in every slot having exactly one downloaded clip, with no extra downloads beyond that, verified via a debug panel of local paths/durations and by observing yt-dlp is invoked exactly once per slot.
- **M3 — Basic timeline render (hard cuts only)**: `filter_graph.py` for sequential trims (default center-crop-to-fill 9:16, no overlay yet), narration + clip-audio mux, export endpoint. *Done when*: paragraph → nouns → clips → single MP4 with hard cuts at correct timestamps, both audio tracks present, playable.
- **M4 — Compositing + crop/zoom + trim-shift UI**: `composite_rng.py`, overlay chains in the filter graph, `proxy.py`, draggable crop/zoom overlay, draggable trim-window slider, `needs_attention` validation. *Done when*: user can drag trim/crop/zoom, see responsive proxy-based preview reflecting multi-layer stacking, and export reproduces it at full res.
- **M5 — Per-slot controls**: next-video (fetches the next `ytsearchN` rank **on click, on demand** — not pre-fetched — using `next_rank_to_try`/`seen_video_ids` to dedupe), new-search (switch active candidate + download its top result on demand; "generate more" candidates on request), manual-search (free text → treated as a new active search string, downloaded on demand), all as targeted per-slot patches that don't reflow timing. *Done when*: any slot's clip can be swapped via any of the three controls independently, and no downloads happen except the single one each action explicitly triggers.
- **M6 — Audio**: global narration mute toggle, per-clip volume/mute wired to `clip.volume`/`clip.muted`, `amix`-based v1 mixing (documented upgrade path to real ducking). *Done when*: export respects per-clip volume/mute and the narration toggle; composited clips' audio mixes without error.
- **M7 — Export polish**: finalized default crop-to-fill, export resolution/bitrate settings, progress bar, download flow, error surfacing, proxy/temp cleanup policy. *Done when*: full pipeline runs start-to-finish reliably to a shareable MP4 with clear progress/success/failure states.

---

## Key Risks

- **yt-dlp fragility/throttling**: version-pin in `requirements.txt`, randomized inter-request delays, distinct "blocked" vs "no result" error types, document periodic `pip install -U yt-dlp`. Lazy, one-clip-at-a-time fetching (no speculative batch downloads) directly minimizes request volume and therefore this risk.
- **ffmpeg filter-graph complexity scaling with clip count**: cap simultaneous overlay layers (3–4, matching "resets to single clip" behavior); snapshot-test `filter_graph.py` against synthetic slot lists independent of real media.
- **edge-tts network dependency**: single point of failure for M1 — cache synthesized audio + timestamps per project (keyed by paragraph text hash) so unrelated edits don't force a re-hit; the offline WPM/syllable fallback stays documented-but-unbuilt unless reliability becomes a real problem.
- **spaCy noun-extraction edge cases**: overlapping noun_chunks, misclassified pronouns, zero-noun short paragraphs, duplicate noun text needing distinct slot ids — handle with explicit offset-based dedup and a "no nouns found" UI state.
- **Preview responsiveness**: debounce crop/zoom/trim drag events; consider a client-side CSS-transform approximation while actively dragging, invoking ffmpeg only on drag-end.
- **Aspect-ratio/crop UX complexity**: crop editor must map consistently between source resolution, proxy resolution, and on-screen element size — isolate this coordinate math in one component (`CropZoomOverlay.tsx`).
- **Search-result relevance**: top-1 yt-dlp result may be a poor match with no automated relevance filtering in v1 — the three manual-override controls are the only mitigation; accepted as a known v1 limitation.
- **Disk usage growth**: downloaded originals + proxies accumulate — cache eviction is explicitly a backlog item, not required for v1.
- **Frontend tooling gap**: no npm/npx/corepack in this environment, only pnpm — all scripts/docs standardize on pnpm from M0.

---

## Verification Plan

- **M1**: manual test with 3–4 varied paragraphs (short/long, few/many nouns, punctuation-heavy) — confirm noun timestamps sound right when narration plays back with visual markers.
- **M2**: confirm cache dedup (same search string twice doesn't re-download), that exactly one download happens per slot on initial timeline construction (no speculative extras), and that throttling/error states surface distinctly in the UI.
- **M3**: play the exported MP4 in a browser/QuickTime; confirm cut timing matches the audio narration by ear.
- **M4**: exercise trim-slide and crop/zoom drag manually; confirm proxy preview and full-res export match visually; force a too-short-clip case and confirm `needs_attention` surfaces.
- **M5**: swap clips via all three controls repeatedly; confirm neighboring slots' timing never shifts.
- **M6**: toggle narration mute and per-clip volume/mute; confirm export reflects each combination.
- **M7**: full run end-to-end on a fresh paragraph with no manual intervention, then again with heavy manual editing, both exporting successfully.
