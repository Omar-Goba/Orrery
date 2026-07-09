import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GalaxyScene } from "./GalaxyScene";
import type { PaperRecord } from "../api/client";
import * as api from "../api/client";

vi.mock("../components/PaperGraph", () => ({
  PaperGraph: () => <div data-testid="paper-graph" />,
}));
vi.mock("../components/PdfReader", () => ({
  PdfReader: () => <div data-testid="pdf-reader" />,
}));

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    listPapers: vi.fn(),
    getTree: vi.fn(),
    getSimilarityGraph: vi.fn().mockResolvedValue({}),
    setPaperStatus: vi.fn(),
    streamReindex: vi.fn(),
  };
});

function makePaper(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    id: "p1",
    filename: "paper.pdf",
    source_filename: "paper.pdf",
    status: "toread",
    title: "A Paper",
    author: "Someone",
    year: "2024",
    summary: null,
    cluster_path: "A/Leaf",
    ingested_at: null,
    ocr_cached: false,
    ...overrides,
  };
}

const fixturePapers = [
  makePaper({ id: "a", cluster_path: "Diffusion/Leaf" }),
  makePaper({ id: "b", cluster_path: "Diffusion/Leaf" }),
  makePaper({ id: "c", cluster_path: "Transformers/Leaf" }),
];

describe("GalaxyScene gating", () => {
  beforeEach(() => {
    vi.mocked(api.listPapers).mockResolvedValue(fixturePapers);
    vi.mocked(api.getTree).mockResolvedValue({
      type: "root", name: "root", status: null, children: [],
    } as unknown as Awaited<ReturnType<typeof api.getTree>>);
  });

  it("observer mode hides upload and reindex controls, shows tour + search", async () => {
    render(
      <GalaxyScene galaxy="omar" mode="observer" onExitToUniverse={() => {}} />
    );

    expect((await screen.findAllByTestId("paper-graph")).length).toBeGreaterThan(0);
    expect(screen.queryAllByLabelText("Upload a PDF").length).toBe(0);
    expect(screen.queryAllByLabelText("Reindex library").length).toBe(0);
    expect(await screen.findByText("Take the tour")).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText("Search titles, authors...").length).toBeGreaterThan(0);
  });

  it("owner mode shows upload and reindex controls", async () => {
    render(
      <GalaxyScene galaxy="omar" mode="owner" onExitToUniverse={() => {}} />
    );

    await screen.findAllByTestId("paper-graph");
    expect((await screen.findAllByLabelText("Upload a PDF")).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Reindex library").length).toBeGreaterThan(0);
  });
});

describe("GalaxyScene empty galaxy", () => {
  beforeEach(() => {
    vi.mocked(api.listPapers).mockClear();
    vi.mocked(api.getTree).mockClear();
  });

  it("skips the fetch and shows the dark-galaxy empty state for a non-owner galaxy", async () => {
    const onExitToUniverse = vi.fn();
    render(
      <GalaxyScene galaxy="nova" mode="observer" onExitToUniverse={onExitToUniverse} />
    );

    expect(await screen.findByText(/your galaxy is dark/i)).toBeInTheDocument();
    expect(api.listPapers).not.toHaveBeenCalled();
    expect(api.getTree).not.toHaveBeenCalled();

    screen.getByText(/visit omar's galaxy/i).click();
    expect(onExitToUniverse).toHaveBeenCalled();
  });
});
