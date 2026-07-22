import { describe, expect, it } from "vitest";
import {
  ellipsizeLabel,
  placeSemanticLabels,
  semanticLabelBudget,
  type LabelCandidate,
} from "./semanticLabels";

const bounds = { left: 0, right: 400, top: 0, bottom: 300 };

function candidate(id: string, x: number, y: number, priority = 0): LabelCandidate {
  return { id, x, y, width: 100, height: 16, offset: 12, priority };
}

describe("semantic graph labels", () => {
  it("keeps labels fixed to a zoom-based density budget", () => {
    expect(semanticLabelBudget(1.8, 1280, 720)).toBe(0);
    expect(semanticLabelBudget(6, 1280, 720)).toBe(18);
    expect(semanticLabelBudget(6, 4000, 2400)).toBe(24);
  });

  it("ellipsizes by measured width rather than character count", () => {
    const measure = (text: string) => text.split("").reduce((width, char) => width + (char === "W" ? 12 : 4), 0);
    expect(ellipsizeLabel("Wide WWW title", 50, measure)).toBe("Wide W…");
    expect(ellipsizeLabel("narrow", 50, measure)).toBe("narrow");
  });

  it("uses alternate anchors to avoid collisions and preserves prior anchors", () => {
    const first = placeSemanticLabels(
      [candidate("a", 180, 150, 2), candidate("b", 185, 150, 1)],
      bounds,
      [],
      2,
    );

    expect(first).toHaveLength(2);
    const [a, b] = first.map(label => label.rect);
    const overlaps = a.x < b.x + b.width && a.x + a.width > b.x
      && a.y < b.y + b.height && a.y + a.height > b.y;
    expect(overlaps).toBe(false);
    const previous = new Map(first.map(label => [label.id, label.anchor]));
    const second = placeSemanticLabels(
      [candidate("a", 181, 150, 2), candidate("b", 186, 150, 1)],
      bounds,
      [],
      2,
      previous,
    );
    expect(second.map(label => label.anchor)).toEqual(first.map(label => label.anchor));
  });

  it("always places required focus labels even when the normal budget is zero", () => {
    const focused = { ...candidate("focus", 390, 150), required: true };
    const placed = placeSemanticLabels([focused, candidate("ordinary", 200, 150)], bounds, [], 0);

    expect(placed.map(label => label.id)).toEqual(["focus"]);
    expect(placed[0].rect.x + placed[0].rect.width).toBeLessThanOrEqual(bounds.right);
  });
});
