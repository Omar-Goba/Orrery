import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GalaxyScene } from "./GalaxyScene";
import type { PaperRecord } from "../api/client";
import * as api from "../api/client";
import type { Session } from "../auth/session";

const sceneMocks = vi.hoisted(() => {
  const orb = {
    update: vi.fn(),
    resolve: vi.fn(),
    cancel: vi.fn(),
  };
  return {
    orb,
    spawnIngestOrb: vi.fn(() => orb),
    desktopPortalProps: null as unknown,
    mobilePortalProps: null as unknown,
    desktopGraphProps: null as unknown,
    mobileGraphProps: null as unknown,
  };
});

vi.mock("../components/PaperGraph", async () => {
  const React = await import("react");
  return {
    PaperGraph: React.forwardRef((props: unknown, ref) => {
      const graphProps = props as { active?: boolean };
      if (graphProps.active === undefined) sceneMocks.desktopGraphProps = props;
      else sceneMocks.mobileGraphProps = props;
      React.useImperativeHandle(ref, () => ({
        pulseCitations: vi.fn(),
        spawnIngestOrb: sceneMocks.spawnIngestOrb,
        focusCluster: vi.fn(),
        igniteStar: vi.fn(),
      }));
      return React.createElement("div", { "data-testid": "paper-graph" });
    }),
  };
});
vi.mock("../components/AgentPortal", async () => {
  const React = await import("react");
  return {
    AgentPortal: (props: unknown) => {
      const portalProps = props as { variant?: string; disableUpload?: boolean };
      if (portalProps.variant === "float") sceneMocks.desktopPortalProps = props;
      else sceneMocks.mobilePortalProps = props;
      return React.createElement(
        "div",
        { "data-testid": portalProps.variant === "float" ? "desktop-portal" : "mobile-portal" },
        portalProps.disableUpload
          ? null
          : React.createElement("button", { "aria-label": "Upload a PDF" }, "Upload")
      );
    },
  };
});
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
    listKeeperVoyagers: vi.fn().mockResolvedValue([]),
    listKeeperVoyagerFiles: vi.fn().mockResolvedValue([]),
    setPaperStatus: vi.fn(),
    streamReindex: vi.fn(),
    getPaperUrl: vi.fn((id: string, mode?: string) => `/paper/${mode ?? "normal"}/${id}`),
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

const keeperSession: Session = {
  username: "omar",
  displayName: "Omar",
  role: "keeper",
  isOwner: true,
  storageUsedBytes: 0,
  storageQuotaBytes: 1024,
  createdAt: "2026-01-01T00:00:00Z",
};

const voyagerSession: Session = {
  username: "nova",
  displayName: "Nova",
  role: "voyager",
  isOwner: false,
  storageUsedBytes: 0,
  storageQuotaBytes: 1024,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("GalaxyScene gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sceneMocks.desktopPortalProps = null;
    sceneMocks.mobilePortalProps = null;
    sceneMocks.desktopGraphProps = null;
    sceneMocks.mobileGraphProps = null;
    sceneMocks.spawnIngestOrb.mockReturnValue(sceneMocks.orb);
    vi.mocked(api.listPapers).mockResolvedValue(fixturePapers);
    vi.mocked(api.getTree).mockResolvedValue({
      type: "root", name: "root", status: null, children: [],
    } as unknown as Awaited<ReturnType<typeof api.getTree>>);
  });

  it("observer mode hides upload and reindex controls, shows tour + search", async () => {
    render(
      <GalaxyScene galaxy="omar" mode="observer" session={null} onExitToUniverse={() => {}} />
    );

    expect((await screen.findAllByTestId("paper-graph")).length).toBeGreaterThan(0);
    expect(screen.queryAllByLabelText("Upload a PDF").length).toBe(0);
    expect(screen.queryAllByLabelText("Reindex library").length).toBe(0);
    expect(await screen.findByText("Take the tour")).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText("Search titles, authors...").length).toBeGreaterThan(0);
    expect(api.listPapers).toHaveBeenCalledWith("tour");
    expect(api.getTree).toHaveBeenCalledWith("tour");
  });

  it("owner mode shows upload and reindex controls", async () => {
    render(
      <GalaxyScene galaxy="omar" mode="owner" session={null} onExitToUniverse={() => {}} />
    );

    await screen.findAllByTestId("paper-graph");
    expect((await screen.findAllByLabelText("Upload a PDF")).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Reindex library").length).toBeGreaterThan(0);
    expect(api.listPapers).toHaveBeenCalledWith("normal");
    expect(api.getTree).toHaveBeenCalledWith("normal");
  });

  it("shows the Storage Ledger only for keeper owner sessions", async () => {
    const { rerender } = render(
      <GalaxyScene galaxy="omar" mode="owner" session={keeperSession} onExitToUniverse={() => {}} />
    );

    expect(await screen.findAllByText("Storage Ledger")).toHaveLength(2);
    expect(api.listKeeperVoyagers).toHaveBeenCalled();

    rerender(
      <GalaxyScene galaxy="nova" mode="owner" session={voyagerSession} onExitToUniverse={() => {}} />
    );

    expect(screen.queryByText("Storage Ledger")).not.toBeInTheDocument();
  });

  it("voyager owner mode loads their own normal API galaxy", async () => {
    render(
      <GalaxyScene galaxy="nova" mode="owner" session={voyagerSession} onExitToUniverse={() => {}} />
    );

    await screen.findAllByTestId("paper-graph");
    expect(api.listPapers).toHaveBeenCalledWith("normal");
    expect(api.getTree).toHaveBeenCalledWith("normal");
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
      <GalaxyScene galaxy="nova" mode="observer" session={null} onExitToUniverse={onExitToUniverse} />
    );

    expect(await screen.findByText(/your galaxy is dark/i)).toBeInTheDocument();
    expect(api.listPapers).not.toHaveBeenCalled();
    expect(api.getTree).not.toHaveBeenCalled();

    screen.getByText(/visit omar's galaxy/i).click();
    expect(onExitToUniverse).toHaveBeenCalled();
  });
});

interface UploadPortalProps {
  onUploadDone?: () => void;
  onUploadStart?: (seed: string) => void;
  onUploadProgress?: (progress: { step: string; pct: number }) => void;
  onUploadResolve?: (paper: PaperRecord) => void;
  onUploadCancel?: () => void;
}

describe("GalaxyScene upload lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sceneMocks.desktopPortalProps = null;
    sceneMocks.mobilePortalProps = null;
    sceneMocks.desktopGraphProps = null;
    sceneMocks.mobileGraphProps = null;
    sceneMocks.spawnIngestOrb.mockReturnValue(sceneMocks.orb);
    vi.mocked(api.listPapers).mockResolvedValue(fixturePapers);
    vi.mocked(api.getTree).mockResolvedValue({
      type: "root", name: "root", status: null, children: [],
    } as unknown as Awaited<ReturnType<typeof api.getTree>>);
  });

  it("forwards the seed, every progress update, and full record to the desktop orb", async () => {
    render(<GalaxyScene galaxy="omar" mode="owner" session={null} onExitToUniverse={() => {}} />);
    await screen.findAllByTestId("paper-graph");
    const portal = sceneMocks.desktopPortalProps as UploadPortalProps;

    act(() => portal.onUploadStart?.("orbit.pdf:42"));
    expect(sceneMocks.spawnIngestOrb).toHaveBeenCalledWith("orbit.pdf:42");

    const updates = [
      { step: "OCR", pct: 5 },
      { step: "Embedding", pct: 60 },
      { step: "Finalizing", pct: 100 },
    ];
    act(() => updates.forEach(progress => portal.onUploadProgress?.(progress)));
    expect(sceneMocks.orb.update.mock.calls.map(([progress]) => progress)).toEqual(updates);

    const resolved = makePaper({ id: "new-paper", cluster_path: "New/Cluster" });
    act(() => portal.onUploadResolve?.(resolved));
    expect(sceneMocks.orb.resolve).toHaveBeenCalledWith(resolved);
    expect(sceneMocks.orb.resolve.mock.calls[0][0]).toBe(resolved);
  });

  it("resolves before completion starts the authoritative graph refresh", async () => {
    render(<GalaxyScene galaxy="omar" mode="owner" session={null} onExitToUniverse={() => {}} />);
    await waitFor(() => expect(api.listPapers).toHaveBeenCalled());
    const portal = sceneMocks.desktopPortalProps as UploadPortalProps;
    act(() => portal.onUploadStart?.("orbit.pdf:42"));
    vi.mocked(api.listPapers).mockClear();
    vi.mocked(api.getTree).mockClear();
    sceneMocks.orb.resolve.mockClear();
    const resolved = makePaper({ id: "new-paper" });

    await act(async () => {
      portal.onUploadResolve?.(resolved);
      portal.onUploadDone?.();
      await Promise.resolve();
    });

    expect(sceneMocks.orb.resolve).toHaveBeenCalledWith(resolved);
    expect(api.listPapers).toHaveBeenCalledWith("normal");
    expect(sceneMocks.orb.resolve.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(api.listPapers).mock.invocationCallOrder[0]);
  });

  it("cancels errors and replacement starts idempotently", async () => {
    render(<GalaxyScene galaxy="omar" mode="owner" session={null} onExitToUniverse={() => {}} />);
    await screen.findAllByTestId("paper-graph");
    const portal = sceneMocks.desktopPortalProps as UploadPortalProps;

    act(() => {
      portal.onUploadStart?.("first.pdf:1");
      portal.onUploadStart?.("second.pdf:2");
    });
    expect(sceneMocks.orb.cancel).toHaveBeenCalledTimes(1);
    expect(sceneMocks.spawnIngestOrb).toHaveBeenLastCalledWith("second.pdf:2");

    act(() => {
      portal.onUploadCancel?.();
      portal.onUploadCancel?.();
    });
    expect(sceneMocks.orb.cancel).toHaveBeenCalledTimes(2);
  });

  it("keeps mobile chat disconnected from the desktop graph lifecycle", async () => {
    render(<GalaxyScene galaxy="omar" mode="owner" session={null} onExitToUniverse={() => {}} />);
    await screen.findAllByTestId("paper-graph");
    const desktop = sceneMocks.desktopPortalProps as UploadPortalProps;
    const mobile = sceneMocks.mobilePortalProps as UploadPortalProps;

    expect(desktop.onUploadStart).toBeTypeOf("function");
    expect(desktop.onUploadProgress).toBeTypeOf("function");
    expect(desktop.onUploadResolve).toBeTypeOf("function");
    expect(desktop.onUploadCancel).toBeTypeOf("function");
    expect(mobile.onUploadStart).toBeUndefined();
    expect(mobile.onUploadProgress).toBeUndefined();
    expect(mobile.onUploadResolve).toBeUndefined();
    expect(mobile.onUploadCancel).toBeUndefined();
    expect(mobile.onUploadDone).toBeTypeOf("function");
    expect(sceneMocks.mobileGraphProps).toMatchObject({ active: false });
  });
});
