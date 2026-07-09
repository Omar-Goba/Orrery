import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperRecord } from "../api/client";
import type { PaperGraphHandle } from "./PaperGraph";
import { TourController } from "./TourController";
import { buildTourStops } from "../lib/tour";

function makePaper(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    id: "p1",
    filename: "paper.pdf",
    original_path: "/papers/paper.pdf",
    status: "toread",
    title: "A Paper",
    author: "Someone",
    year: "2024",
    summary: null,
    cluster_path: "A/Leaf",
    symlink_name: null,
    ingested_at: null,
    ocr_cached: false,
    ...overrides,
  };
}

describe("buildTourStops", () => {
  it("sorts by member count descending", () => {
    const papers = [
      ...Array.from({ length: 2 }, (_, i) => makePaper({ id: `b${i}`, cluster_path: "B/Leaf" })),
      ...Array.from({ length: 5 }, (_, i) => makePaper({ id: `a${i}`, cluster_path: "A/Leaf" })),
    ];
    const stops = buildTourStops(papers);
    expect(stops[0].path).toBe("A");
    expect(stops[0].count).toBe(5);
    expect(stops[1].path).toBe("B");
    expect(stops[1].count).toBe(2);
  });

  it("excludes the Misc cluster", () => {
    const papers = [
      makePaper({ id: "a", cluster_path: "Misc/Leaf" }),
      makePaper({ id: "b", cluster_path: "Real/Leaf" }),
    ];
    const stops = buildTourStops(papers);
    expect(stops.some(s => s.path === "Misc")).toBe(false);
    expect(stops.some(s => s.path === "Real")).toBe(true);
  });

  it("caps at 5 stops by default", () => {
    const papers = Array.from({ length: 8 }, (_, i) =>
      makePaper({ id: `p${i}`, cluster_path: `Cluster${i}/Leaf` })
    );
    expect(buildTourStops(papers).length).toBe(5);
  });

  it("does not crash or drop entries on ties", () => {
    const papers = [
      makePaper({ id: "a", cluster_path: "A/Leaf" }),
      makePaper({ id: "b", cluster_path: "B/Leaf" }),
    ];
    const stops = buildTourStops(papers);
    expect(stops.map(s => s.path).sort()).toEqual(["A", "B"]);
  });
});

describe("TourController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function Harness({ focusCluster }: { focusCluster: (path: string | null) => void }) {
    const graphRef = useRef<PaperGraphHandle>({
      pulseCitations: () => {},
      spawnMeteor: () => ({ arrive: () => {}, cancel: () => {} }),
      focusCluster,
      igniteStar: () => {},
    });
    return <TourController papers={papers} graphRef={graphRef} onHighlightPath={() => {}} />;
  }

  const papers = [
    ...Array.from({ length: 4 }, (_, i) => makePaper({ id: `a${i}`, cluster_path: "Alpha/Leaf" })),
    ...Array.from({ length: 3 }, (_, i) => makePaper({ id: `b${i}`, cluster_path: "Beta/Leaf" })),
  ];

  it("flies to the top cluster on start, then the next stop after fly+dwell", () => {
    const focusCluster = vi.fn();
    render(<Harness focusCluster={focusCluster} />);

    fireEvent.click(screen.getByText("Take the tour"));
    expect(focusCluster).toHaveBeenCalledWith("Alpha");
    expect(focusCluster).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(600 + 3500 + 10);
    });
    expect(focusCluster).toHaveBeenCalledWith("Beta");
    expect(focusCluster).toHaveBeenCalledTimes(2);
  });

  it("stops on Escape and clears pending timers — no further focusCluster calls", () => {
    const focusCluster = vi.fn();
    render(<Harness focusCluster={focusCluster} />);

    fireEvent.click(screen.getByText("Take the tour"));
    expect(focusCluster).toHaveBeenCalledTimes(1);

    // Mid-dwell on stop 1
    act(() => {
      vi.advanceTimersByTime(600 + 100);
    });

    fireEvent.keyDown(window, { key: "Escape" });
    const callsAtStop = focusCluster.mock.calls.length;

    // Advance well past when stop 2 would have fired if timers weren't cleared
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(focusCluster).toHaveBeenCalledTimes(callsAtStop);
  });
});
