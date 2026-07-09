import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTourGalaxy, listPapers, loginAuth, streamChat } from "./client";

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
});
