import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, PaperRecord, SSEEvent } from "../api/client";
import * as api from "../api/client";
import { AgentPortal } from "./AgentPortal";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getMe: vi.fn(),
    uploadPaper: vi.fn(),
  };
});

const user: AuthUser = {
  handle: "omar",
  display_name: "Omar",
  role: "keeper",
  storage_used_bytes: 10,
  storage_quota_bytes: 1000,
  created_at: "2026-01-01T00:00:00Z",
};

const paper: PaperRecord = {
  id: "paper-42",
  filename: "orbit.pdf",
  source_filename: "orbit.pdf",
  status: "toread",
  title: "Orbital Systems",
  author: "Nova",
  year: "2026",
  summary: null,
  cluster_path: "Physics/Orbits",
  ingested_at: "2026-07-16T00:00:00Z",
  ocr_cached: false,
};

function chooseFile(container: HTMLElement, contents = "data") {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  const file = new File([contents], "orbit.pdf", { type: "application/pdf" });
  fireEvent.change(input!, { target: { files: [file] } });
  return file;
}

describe("AgentPortal upload lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getMe).mockResolvedValue(user);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("uses the exact file seed and forwards every progress event, including 100", async () => {
    let emit: ((event: SSEEvent) => void) | undefined;
    let finish: (() => void) | undefined;
    vi.mocked(api.uploadPaper).mockImplementation((_file, _status, onEvent) => {
      emit = onEvent;
      return new Promise<void>(resolve => { finish = resolve; });
    });
    const onUploadStart = vi.fn();
    const onUploadProgress = vi.fn();
    const { container } = render(
      <AgentPortal onUploadStart={onUploadStart} onUploadProgress={onUploadProgress} />
    );
    const file = chooseFile(container, "123456");

    fireEvent.click(screen.getByText("Ingest"));
    expect(onUploadStart).toHaveBeenCalledWith(`orbit.pdf:${file.size}`);
    await waitFor(() => expect(emit).toBeDefined());

    act(() => emit?.({ type: "progress", step: "Reading pages", pct: 5 }));
    expect(screen.getByText("Reading pages")).toBeInTheDocument();
    expect(screen.getByText("5%")).toBeInTheDocument();
    expect(container.querySelector("[data-ingest-phase]")).toHaveAttribute("data-ingest-phase", "arrival");

    act(() => emit?.({ type: "progress", step: "Embedding", pct: 60 }));
    act(() => emit?.({ type: "progress", step: "Finalizing", pct: 100 }));
    expect(onUploadProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { step: "Reading pages", pct: 5 },
      { step: "Embedding", pct: 60 },
      { step: "Finalizing", pct: 100 },
    ]);
    expect(screen.getByText("Finalizing")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(container.querySelector("[data-ingest-phase]")).toHaveAttribute("data-ingest-phase", "holding");
    expect(container.querySelector('[style="width: 100%;"]')).toBeInTheDocument();

    act(() => finish?.());
  });

  it("resolves the full record before refresh and starts storage refresh independently", async () => {
    const order: string[] = [];
    vi.mocked(api.uploadPaper).mockImplementation(async (_file, _status, onEvent) => {
      onEvent({ type: "done", paper });
    });
    const onUploadResolve = vi.fn((resolved: PaperRecord) => {
      expect(resolved).toBe(paper);
      order.push("resolve");
    });
    const onUploadDone = vi.fn(() => order.push("refresh"));
    const { container } = render(
      <AgentPortal onUploadResolve={onUploadResolve} onUploadDone={onUploadDone} />
    );
    await waitFor(() => expect(api.getMe).toHaveBeenCalledTimes(1));
    vi.mocked(api.getMe).mockImplementation(() => {
      order.push("storage");
      return Promise.resolve(user);
    });
    chooseFile(container);

    fireEvent.click(screen.getByText("Ingest"));

    await waitFor(() => expect(onUploadResolve).toHaveBeenCalledWith(paper));
    expect(order).toEqual(["resolve", "refresh", "storage"]);
    expect(await screen.findByText(/Indexed/)).toBeInTheDocument();
    expect(screen.getAllByText("Orbital Systems")).toHaveLength(2);
  });

  it("cancels the visual lifecycle and retains the upload error message", async () => {
    vi.mocked(api.uploadPaper).mockRejectedValue(new Error("SSE connection error"));
    const onUploadCancel = vi.fn();
    const { container } = render(<AgentPortal onUploadCancel={onUploadCancel} />);
    chooseFile(container);

    fireEvent.click(screen.getByText("Ingest"));

    expect(await screen.findByText("SSE connection error")).toBeInTheDocument();
    expect(onUploadCancel).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-ingest-phase]")).not.toBeInTheDocument();
  });
});
