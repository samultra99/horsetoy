import type { CropRect } from "../api/client";

/**
 * The editor thinks in zoom + pan; the renderer thinks in a crop rectangle.
 * These two conversions are the bridge, and they assume the square-ish
 * effective window that the editor is the only thing ever writing back.
 */
export function cropRectToZoomPan(rect: CropRect) {
  const zoom = rect.w > 0 ? 1 / rect.w : 1;
  const maxOffset = 1 - rect.w;
  return {
    zoom,
    panX: maxOffset > 0 ? rect.x / maxOffset : 0.5,
    panY: maxOffset > 0 ? rect.y / maxOffset : 0.5,
  };
}

export function zoomPanToCropRect(zoom: number, panX: number, panY: number): CropRect {
  const size = 1 / zoom;
  const maxOffset = 1 - size;
  return { x: panX * maxOffset, y: panY * maxOffset, w: size, h: size };
}

/**
 * CSS that frames a video exactly the way the ffmpeg crop will: the picture is
 * drawn at zoom×100% of the frame and shifted by pan × whatever room the zoom
 * left over, so pan does nothing at zoom 1 — same as the renderer's maxOffset.
 */
export function framingStyle(rect: CropRect) {
  const { zoom, panX, panY } = cropRectToZoomPan(rect);
  return {
    width: `${zoom * 100}%`,
    height: `${zoom * 100}%`,
    left: `${-(zoom - 1) * panX * 100}%`,
    top: `${-(zoom - 1) * panY * 100}%`,
  };
}
