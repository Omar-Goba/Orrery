import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSession, login, logout, refreshSession, signup } from "./session";
import { getMe, loginAuth, logoutAuth, signupAuth } from "../api/client";

vi.mock("../api/client", () => ({
  getMe: vi.fn(),
  loginAuth: vi.fn(),
  logoutAuth: vi.fn(),
  signupAuth: vi.fn(),
}));

const voyager = {
  handle: "nova",
  display_name: "Nova",
  role: "voyager" as const,
  storage_used_bytes: 0,
  storage_quota_bytes: 1,
  created_at: "2026-01-01T00:00:00Z",
};

const keeper = {
  ...voyager,
  handle: "omar",
  display_name: "Omar",
  role: "keeper" as const,
};

describe("auth/session", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(getMe).mockReset();
    vi.mocked(loginAuth).mockReset();
    vi.mocked(logoutAuth).mockReset();
    vi.mocked(signupAuth).mockReset();
  });

  it("logs in through the backend and caches the session", async () => {
    vi.mocked(loginAuth).mockResolvedValue(voyager);

    const session = await login(" Nova ", "secretpassword");

    expect(loginAuth).toHaveBeenCalledWith("nova", "secretpassword");
    expect(session).toMatchObject({ username: "nova", role: "voyager", isOwner: false });
    expect(getSession()).toMatchObject({ username: "nova" });
  });

  it("marks backend keepers as owners", async () => {
    vi.mocked(loginAuth).mockResolvedValue(keeper);

    const session = await login("omar", "secretpassword");

    expect(session.isOwner).toBe(true);
  });

  it("signs up with an invite code", async () => {
    vi.mocked(signupAuth).mockResolvedValue(voyager);

    await signup("nova", "secretpassword", "letmein");

    expect(signupAuth).toHaveBeenCalledWith("nova", "secretpassword", "letmein");
  });

  it("refreshes from /me and clears stale sessions", async () => {
    vi.mocked(getMe).mockResolvedValueOnce(voyager);
    expect(await refreshSession()).toMatchObject({ username: "nova" });

    vi.mocked(getMe).mockRejectedValueOnce(new Error("401"));
    expect(await refreshSession()).toBeNull();
    expect(getSession()).toBeNull();
  });

  it("returns null (not a throw) for no stored session", () => {
    expect(getSession()).toBeNull();
  });

  it("returns null (not a throw) for corrupt JSON in storage", () => {
    localStorage.setItem("orrery.session", "{not valid json");
    expect(getSession()).toBeNull();
  });

  it("logout clears the session after revoking the backend cookie", async () => {
    vi.mocked(loginAuth).mockResolvedValue(voyager);
    await login("nova", "secretpassword");

    await logout();

    expect(logoutAuth).toHaveBeenCalled();
    expect(getSession()).toBeNull();
  });
});
