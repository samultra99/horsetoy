import { useProjectStore } from "../../state/projectStore";
import { SlotEditorCard } from "./SlotEditorCard";

export function SlotEditorList() {
  const status = useProjectStore((s) => s.status);
  const slots = useProjectStore((s) => s.slots);

  if (status !== "ready") return null;
  // Failed slots still get a card (without the video/crop/trim/volume
  // controls, which need an actual downloaded clip) so the user has a way
  // to retry via next-video/new-search/manual-search instead of being stuck.
  const editableSlots = slots.filter(
    (s) => s.clip.download_status === "ready" || s.clip.download_status === "failed",
  );
  if (editableSlots.length === 0) return null;

  return (
    <div style={{ marginTop: "1rem" }}>
      <h3 style={{ fontSize: 13, color: "#888", marginBottom: 0 }}>Edit clips</h3>
      {editableSlots.map((slot) => (
        <SlotEditorCard key={slot.id} slot={slot} />
      ))}
    </div>
  );
}
