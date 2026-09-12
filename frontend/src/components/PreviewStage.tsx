import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../api/client";
import { framingStyle } from "../state/crop";
import { useProjectStore } from "../state/projectStore";
import { layersAt, planGroups, sourceTimeFor, timelineEnd } from "../state/timeline";

function clipUrl(localPath: string): string {
  const filename = localPath.split("/").pop() ?? "";
  return `${API_BASE}/media/clips/${encodeURIComponent(filename)}`;
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = safe - mins * 60;
  return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
}

// How far a video may drift from its mark before we yank it back. Tight while
// scrubbing (you want the exact frame), loose while playing (a correction on
// every frame just makes it stutter).
const DRIFT_SCRUB = 0.05;
const DRIFT_PLAY = 0.35;

export function PreviewStage() {
  const slots = useProjectStore((s) => s.slots);
  const playhead = useProjectStore((s) => s.playhead);
  const playing = useProjectStore((s) => s.playing);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);
  const setPlaying = useProjectStore((s) => s.setPlaying);
  const narrationAudioUrl = useProjectStore((s) => s.narrationAudioUrl);
  const narrationMuted = useProjectStore((s) => s.narrationMuted);
  const showExport = useProjectStore((s) => s.showExport);
  const exportUrl = useProjectStore((s) => s.exportUrl);
  const dismissExport = useProjectStore((s) => s.dismissExport);

  const audioRef = useRef<HTMLAudioElement>(null);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // The frame has to be exactly 16:9 whichever way the window is squeezed —
  // the preview is only trustworthy if it is framed like the export.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const scale = Math.min(el.clientWidth / 16, el.clientHeight / 9);
      setBox({ width: Math.floor(scale * 16), height: Math.floor(scale * 9) });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);

  const groups = useMemo(() => planGroups(slots), [slots]);
  const end = timelineEnd(groups);
  const active = useMemo(() => layersAt(groups, playhead), [groups, playhead]);
  const alphaById = useMemo(
    () => new Map(active.map((a) => [a.layer.slot.id, a.alpha])),
    [active],
  );

  // Playback clock: the narration is the master when it's rolling, because
  // audio hiccups read as far worse than a frame of video drift.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const audio = audioRef.current;

    const tick = () => {
      const now = performance.now();
      const wallDelta = (now - last) / 1000;
      last = now;
      const next =
        audio && !audio.paused && !audio.seeking
          ? audio.currentTime
          : useProjectStore.getState().playhead + wallDelta;

      if (next >= end) {
        setPlayhead(end);
        setPlaying(false);
        return;
      }
      setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, end, setPlayhead, setPlaying]);

  // Narration follows play/pause, and follows the playhead when it jumps
  // somewhere the clock wouldn't have taken it (a scrub).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = narrationMuted;
    if (Math.abs(audio.currentTime - playhead) > DRIFT_PLAY) audio.currentTime = playhead;
    if (playing && audio.paused) void audio.play().catch(() => undefined);
    if (!playing && !audio.paused) audio.pause();
  }, [playing, playhead, narrationMuted]);

  // Every visible layer gets parked on the exact frame the export would show
  // at this moment; everything else is paused so it isn't burning CPU or,
  // worse, playing audio from off screen.
  useEffect(() => {
    const activeIds = new Set(active.map((a) => a.layer.slot.id));
    for (const [id, video] of videos.current) {
      if (!activeIds.has(id) && !video.paused) video.pause();
    }
    for (const { layer } of active) {
      const video = videos.current.get(layer.slot.id);
      if (!video) continue;
      const target = sourceTimeFor(layer, playhead);
      const tolerance = playing ? DRIFT_PLAY : DRIFT_SCRUB;
      if (Number.isFinite(target) && Math.abs(video.currentTime - target) > tolerance) {
        video.currentTime = target;
      }
      video.muted = layer.slot.clip.muted;
      video.volume = Math.min(Math.max(layer.slot.clip.volume, 0), 1);
      if (playing && video.paused) void video.play().catch(() => undefined);
      if (!playing && !video.paused) video.pause();
    }
  }, [active, playhead, playing]);

  const readySlots = slots.filter((s) => s.clip.download_status === "ready" && s.clip.local_path);
  const nothingToShow = !active.some(({ layer }) => layer.slot.clip.download_status === "ready");

  return (
    <div className="stage-wrap" ref={wrapRef}>
      <div className="stage" style={{ width: box.width, height: box.height }}>
        {showExport && exportUrl ? (
          <video className="stage-export" src={`${API_BASE}${exportUrl}`} controls autoPlay />
        ) : (
          <>
            {readySlots.map((slot) => {
              const alpha = alphaById.get(slot.id) ?? 0;
              return (
                <video
                  key={slot.id}
                  ref={(el) => {
                    if (el) videos.current.set(slot.id, el);
                    else videos.current.delete(slot.id);
                  }}
                  src={clipUrl(slot.clip.local_path as string)}
                  playsInline
                  preload="auto"
                  // Park each clip on its first frame as soon as it loads, so
                  // cutting to it mid-playback doesn't flash black while the
                  // decoder catches up.
                  onLoadedMetadata={(e) => {
                    e.currentTarget.currentTime = slot.clip.trim_start;
                  }}
                  className="stage-layer"
                  style={{ ...framingStyle(slot.clip.crop_rect), opacity: alpha }}
                />
              );
            })}
            {(readySlots.length === 0 || nothingToShow) && (
              <div className="stage-empty">
                {slots.length === 0
                  ? "Write something and build a timeline."
                  : readySlots.length === 0
                    ? "No clips yet — fetch clips to see the edit."
                    : "Nothing on screen at this point."}
              </div>
            )}
          </>
        )}
        {showExport && (
          <button className="stage-badge" onClick={dismissExport} title="Back to the live edit">
            exported cut · back to editing
          </button>
        )}
      </div>

      {narrationAudioUrl && (
        <audio ref={audioRef} src={`${API_BASE}${narrationAudioUrl}`} preload="auto" />
      )}
    </div>
  );
}
