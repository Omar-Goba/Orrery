import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./components/PaperGraph", () => ({
  PaperGraph: () => <div data-testid="paper-graph" />,
}));
vi.mock("./components/StarfieldCanvas", () => ({
  StarfieldCanvas: () => <div data-testid="starfield" />,
}));
vi.mock("./components/PdfReader", () => ({
  // react-pdf needs browser APIs (DOMMatrix) jsdom doesn't provide — stub it,
  // these tests are about scene gating/flow, not the PDF viewer itself.
  PdfReader: () => <div data-testid="pdf-reader" />,
}));
vi.mock("./scenes/WarpOverlay", () => ({
  // Fire the swap + done callbacks synchronously so tests don't sit through
  // the real rAF-driven 900ms animation.
  WarpOverlay: ({ onSwap, onDone }: { onSwap: () => void; onDone: () => void }) => {
    onSwap();
    onDone();
    return null;
  },
}));
vi.mock("./api/client", () => ({
  listPapers: vi.fn().mockResolvedValue([]),
  getTree: vi.fn().mockResolvedValue(null),
  getSimilarityGraph: vi.fn().mockResolvedValue({}),
  setPaperStatus: vi.fn(),
  streamReindex: vi.fn(),
  getPaperUrl: (id: string) => `/papers/${id}`,
}));

describe("App scene flow", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("shows the universe map by default", () => {
    render(<App />);
    expect(screen.getAllByText(/visit as observer/i).length).toBeGreaterThan(0);
  });

  it("warps to the galaxy scene when 'Visit as observer' is clicked", async () => {
    render(<App />);
    const [button] = screen.getAllByRole("button", { name: /visit as observer/i });
    button.click();

    expect((await screen.findAllByTestId("paper-graph")).length).toBeGreaterThan(0);
  });

  it("restores straight into the galaxy scene from a persisted session scene", () => {
    sessionStorage.setItem("orrery.scene", JSON.stringify({ name: "galaxy", galaxy: "omar" }));
    render(<App />);
    expect(screen.getAllByTestId("paper-graph").length).toBeGreaterThan(0);
    expect(screen.queryByText(/visit as observer/i)).not.toBeInTheDocument();
  });
});
