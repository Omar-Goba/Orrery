import { createRef } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperRecord } from "../api/client";
import { PaperGraph, type PaperGraphHandle } from "./PaperGraph";

function paper(id: string, clusterPath: string): PaperRecord {
  return {
    id,
    filename: `${id}.pdf`,
    source_filename: `${id}.pdf`,
    status: "toread",
    title: id,
    author: null,
    year: null,
    summary: null,
    cluster_path: clusterPath,
    ingested_at: null,
    ocr_cached: false,
  };
}

function jitter(id: string, axis: number): number {
  let hash = axis;
  for (let i = 0; i < id.length; i++) hash = Math.imul(31, hash) + id.charCodeAt(i);
  return ((hash >>> 0) / 0xffffffff - 0.5) * 80;
}

describe("PaperGraph living interaction", () => {
  let reducedMotion = false;
  let motionListener: ((event: MediaQueryListEvent) => void) | undefined;
  let originalCanvasDescriptors: Record<string, PropertyDescriptor | undefined>;
  const captured = new Set<number>();
  const canvasProperties = [
    "offsetWidth", "offsetHeight", "getBoundingClientRect", "getContext",
    "setPointerCapture", "releasePointerCapture", "hasPointerCapture",
  ];

  beforeEach(() => {
    class PointerEventStub extends MouseEvent {
      pointerId: number;
      pointerType: string;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    vi.stubGlobal("PointerEvent", PointerEventStub);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: reducedMotion,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { motionListener = listener; },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    originalCanvasDescriptors = Object.fromEntries(
      canvasProperties.map(property => [property, Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property)]),
    );
    Object.defineProperties(HTMLCanvasElement.prototype, {
      offsetWidth: { configurable: true, get: () => 800 },
      offsetHeight: { configurable: true, get: () => 600 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) }),
      },
      getContext: { configurable: true, value: () => ({}) },
      setPointerCapture: { configurable: true, value: (id: number) => captured.add(id) },
      releasePointerCapture: { configurable: true, value: (id: number) => captured.delete(id) },
      hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
    });
  });

  afterEach(() => {
    reducedMotion = false;
    motionListener = undefined;
    captured.clear();
    for (const property of canvasProperties) {
      const descriptor = originalCanvasDescriptors[property];
      if (descriptor) Object.defineProperty(HTMLCanvasElement.prototype, property, descriptor);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype, property);
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves a paper's position across a leaf refresh and retains click semantics", () => {
    const onOpenPaper = vi.fn();
    const first = paper("paper-a", "Alpha/Leaf");
    const second = paper("paper-b", "Beta/Leaf");
    const { container, rerender } = render(
      <PaperGraph papers={[first, second]} onOpenPaper={onOpenPaper} />,
    );
    const canvas = container.querySelectorAll("canvas")[1];
    const oldX = 400 + jitter(first.id, 1);
    const oldY = 79.5 + jitter(first.id, 2);

    rerender(
      <PaperGraph papers={[{ ...first, cluster_path: "Beta/Leaf" }, second]} onOpenPaper={onOpenPaper} />,
    );
    fireEvent.pointerDown(canvas, { clientX: oldX, clientY: oldY, pointerId: 7, pointerType: "mouse", button: 0 });
    expect(captured.has(7)).toBe(true);
    fireEvent.pointerUp(canvas, { clientX: oldX, clientY: oldY, pointerId: 7, pointerType: "mouse", button: 0 });

    expect(onOpenPaper).toHaveBeenCalledWith(expect.objectContaining({ id: first.id, cluster_path: "Beta/Leaf" }));
    expect(captured.has(7)).toBe(false);
    expect(canvas).toHaveStyle({ touchAction: "none" });
  });

  it("suppresses clicks after drag and snaps to the anchor when reduced motion changes live", () => {
    const onOpenPaper = vi.fn();
    const target = paper("paper-a", "Alpha/Leaf");
    const { container } = render(<PaperGraph papers={[target]} onOpenPaper={onOpenPaper} />);
    const canvas = container.querySelectorAll("canvas")[1];
    const startX = 400 + jitter(target.id, 1);
    const startY = 79.5 + jitter(target.id, 2);

    motionListener?.({ matches: true } as MediaQueryListEvent);
    fireEvent.pointerDown(canvas, { clientX: startX, clientY: startY, pointerId: 4, pointerType: "touch", button: 0 });
    fireEvent.pointerMove(canvas, { clientX: startX + 60, clientY: startY + 40, pointerId: 4, pointerType: "touch" });
    fireEvent.pointerUp(canvas, { clientX: startX + 60, clientY: startY + 40, pointerId: 4, pointerType: "touch", button: 0 });
    expect(onOpenPaper).not.toHaveBeenCalled();

    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 79.5, pointerId: 5, pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 79.5, pointerId: 5, pointerType: "mouse", button: 0 });
    expect(onOpenPaper).toHaveBeenCalledWith(expect.objectContaining({ id: target.id }));
  });

  it("snaps a canceled reduced-motion drag back to its anchor", () => {
    reducedMotion = true;
    const onOpenPaper = vi.fn();
    const target = paper("paper-a", "Alpha/Leaf");
    const { container } = render(<PaperGraph papers={[target]} onOpenPaper={onOpenPaper} />);
    const canvas = container.querySelectorAll("canvas")[1];
    const startX = 400 + jitter(target.id, 1);
    const startY = 79.5 + jitter(target.id, 2);

    fireEvent.pointerDown(canvas, { clientX: startX, clientY: startY, pointerId: 6, pointerType: "touch", button: 0 });
    fireEvent.pointerMove(canvas, { clientX: startX + 60, clientY: startY + 40, pointerId: 6, pointerType: "touch" });
    fireEvent.pointerCancel(canvas, { clientX: startX + 60, clientY: startY + 40, pointerId: 6, pointerType: "touch" });

    expect(captured.has(6)).toBe(false);
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 79.5, pointerId: 7, pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 79.5, pointerId: 7, pointerType: "mouse", button: 0 });
    expect(onOpenPaper).toHaveBeenCalledWith(expect.objectContaining({ id: target.id }));
  });

  it("renders a first-upload orb with no nodes and makes cleanup callbacks idempotent", () => {
    let frame: FrameRequestCallback | undefined;
    const gradient = { addColorStop: vi.fn() };
    const context = {
      clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), setTransform: vi.fn(),
      createRadialGradient: vi.fn(() => gradient),
      fillStyle: "", strokeStyle: "", lineWidth: 0, shadowColor: "", shadowBlur: 0,
    };
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => context });
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const ref = createRef<PaperGraphHandle>();
    const { unmount } = render(<PaperGraph ref={ref} papers={[]} />);
    const orb = ref.current!.spawnIngestOrb("first.pdf:10");
    orb.update({ step: "Embedding", pct: 50 });

    act(() => frame?.(100));
    expect(context.createRadialGradient).toHaveBeenCalled();
    expect(context.arc).toHaveBeenCalled();

    now.mockReturnValue(200);
    act(() => motionListener?.({ matches: true } as MediaQueryListEvent));
    expect(() => orb.cancel()).not.toThrow();
    expect(() => orb.cancel()).not.toThrow();
    unmount();
    expect(() => orb.update({ step: "Late", pct: 100 })).not.toThrow();
    expect(() => orb.resolve(paper("late", "Unclustered"))).not.toThrow();
  });

  it("keeps a selected paper label screen-sized at maximum zoom", () => {
    reducedMotion = true;
    let frame: FrameRequestCallback | undefined;
    const drawnText: Array<{ text: string; font: string }> = [];
    const gradient = { addColorStop: vi.fn() };
    const context: Record<string, unknown> = {
      clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      setTransform: vi.fn(),
      createRadialGradient: vi.fn(() => gradient),
      measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
      font: "",
      fillText: vi.fn((text: string) => drawnText.push({ text, font: String(context.font) })),
      fillStyle: "", strokeStyle: "", lineWidth: 0, shadowColor: "", shadowBlur: 0,
      globalAlpha: 1, textAlign: "left", textBaseline: "top",
    };
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => context });
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
    const target = { ...paper("fixed-title", "Alpha/Leaf"), author: "Ada", year: "2026" };
    const { container, rerender } = render(<PaperGraph papers={[target]} />);
    const canvas = container.querySelectorAll("canvas")[1];
    const nodeX = 400 + jitter(target.id, 1);
    const nodeY = 79.5 + jitter(target.id, 2);

    fireEvent.wheel(canvas, { clientX: nodeX, clientY: nodeY, deltaY: -10_000 });
    act(() => frame?.(100));
    expect(drawnText.some(call => call.text === "fixed-title")).toBe(false);

    drawnText.length = 0;
    rerender(<PaperGraph papers={[target]} selectedPaperId={target.id} />);
    act(() => frame?.(200));

    expect(drawnText).toContainEqual({ text: "fixed-title", font: "600 12px Inter, system-ui, sans-serif" });
    expect(drawnText).toContainEqual({ text: "Ada · 2026", font: "400 11px Inter, system-ui, sans-serif" });
    expect(drawnText.filter(call => call.text === "fixed-title")).toHaveLength(1);
    expect(context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
  });
});
