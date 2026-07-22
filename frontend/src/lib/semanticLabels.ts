export interface LabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabelBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface LabelCandidate {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  offset: number;
  priority: number;
  required?: boolean;
}

export interface LabelPlacement extends LabelCandidate {
  anchor: number;
  rect: LabelRect;
}

const COLLISION_PADDING = 3;

export function semanticLabelBudget(zoom: number, width: number, height: number): number {
  if (zoom <= 1.8) return 0;
  const zoomProgress = Math.min(1, (zoom - 1.8) / 2.2);
  const viewportScale = Math.sqrt(Math.max(1, width * height) / (1280 * 720));
  return Math.max(4, Math.min(24, Math.round((6 + zoomProgress * 12) * viewportScale)));
}

export function ellipsizeLabel(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): string {
  if (measure(text) <= maxWidth) return text;
  const ellipsis = "…";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(text.slice(0, middle) + ellipsis) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).trimEnd() + ellipsis;
}

export function placeSemanticLabels(
  candidates: LabelCandidate[],
  bounds: LabelBounds,
  obstacles: LabelRect[],
  budget: number,
  previousAnchors: ReadonlyMap<string, number> = new Map(),
): LabelPlacement[] {
  const occupied = obstacles.map(rect => expand(rect, COLLISION_PADDING));
  const placements: LabelPlacement[] = [];
  let optionalCount = 0;

  const ordered = [...candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const candidate of ordered) {
    if (!candidate.required && optionalCount >= budget) continue;
    const preferred = previousAnchors.get(candidate.id);
    const anchors = preferred === undefined
      ? [0, 1, 2, 3, 4, 5, 6, 7]
      : [preferred, ...[0, 1, 2, 3, 4, 5, 6, 7].filter(anchor => anchor !== preferred)];

    let placement: LabelPlacement | null = null;
    for (const anchor of anchors) {
      const rect = rectForAnchor(candidate, anchor);
      const padded = expand(rect, COLLISION_PADDING);
      if (!withinBounds(padded, bounds) || occupied.some(other => intersects(padded, other))) continue;
      placement = { ...candidate, anchor, rect };
      break;
    }

    if (!placement && candidate.required) {
      const anchor = preferred ?? 0;
      const rect = clampRect(rectForAnchor(candidate, anchor), bounds);
      placement = { ...candidate, anchor, rect };
    }
    if (!placement) continue;

    placements.push(placement);
    occupied.push(expand(placement.rect, COLLISION_PADDING));
    if (!candidate.required) optionalCount++;
  }
  return placements;
}

function rectForAnchor(candidate: LabelCandidate, anchor: number): LabelRect {
  const { x, y, width, height, offset } = candidate;
  switch (anchor) {
    case 1: return { x: x - offset - width, y: y - height / 2, width, height };
    case 2: return { x: x - width / 2, y: y - offset - height, width, height };
    case 3: return { x: x - width / 2, y: y + offset, width, height };
    case 4: return { x: x + offset, y: y - offset - height, width, height };
    case 5: return { x: x - offset - width, y: y - offset - height, width, height };
    case 6: return { x: x + offset, y: y + offset, width, height };
    case 7: return { x: x - offset - width, y: y + offset, width, height };
    default: return { x: x + offset, y: y - height / 2, width, height };
  }
}

function withinBounds(rect: LabelRect, bounds: LabelBounds): boolean {
  return rect.x >= bounds.left && rect.y >= bounds.top
    && rect.x + rect.width <= bounds.right && rect.y + rect.height <= bounds.bottom;
}

function intersects(a: LabelRect, b: LabelRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

function expand(rect: LabelRect, padding: number): LabelRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function clampRect(rect: LabelRect, bounds: LabelBounds): LabelRect {
  return {
    ...rect,
    x: Math.max(bounds.left, Math.min(bounds.right - rect.width, rect.x)),
    y: Math.max(bounds.top, Math.min(bounds.bottom - rect.height, rect.y)),
  };
}
