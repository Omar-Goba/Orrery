import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes, getTourGalaxy, listKeeperVoyagerFiles, listKeeperVoyagers, listPapers, loginAuth, streamChat, uploadPaper } from "./client";

describe("api/client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends cookies on normal authenticated reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listPapers("normal");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/papers",
      { credentials: "include" },
    );
  });

  it("uses the anonymous tour prefix for observer reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listPapers("tour");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/tour/papers",
      { credentials: "include" },
    );
  });

  it("throws instead of returning error JSON as galaxy data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Keeper galaxy unavailable" }), { status: 503 }),
      ),
    );

    await expect(getTourGalaxy()).rejects.toThrow("Request failed with status 503");
  });

  it("logs in with cookies included", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          handle: "omar",
          display_name: "Omar",
          role: "keeper",
          storage_used_bytes: 0,
          storage_quota_bytes: 1,
          created_at: "2026-01-01T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await loginAuth("omar", "secretpassword");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/auth/login",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("emits an SSE error event for failed chat responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "nope" }), { status: 401 })),
    );
    const onEvent = vi.fn();

    streamChat("hello", onEvent, [], "normal");
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());

    expect(onEvent).toHaveBeenCalledWith({ type: "error", message: "Chat failed with status 401" });
  });

  it("fetches keeper storage lens endpoints with cookies", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await listKeeperVoyagers();
    await listKeeperVoyagerFiles("vega-7");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:8000/api/keeper/voyagers",
      { credentials: "include" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8000/api/keeper/voyagers/vega-7/files",
      { credentials: "include" },
    );
  });

  it("turns quota upload errors into usable messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "quota_exceeded", used: 1024, quota: 2048 }), {
          status: 507,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(uploadPaper(new File(["x"], "x.pdf", { type: "application/pdf" }), "toread", vi.fn()))
      .rejects.toThrow("Storage quota exceeded (1.0 KB of 2.0 KB used).");
  });

  it("formats byte values for storage UI", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
  });
});
