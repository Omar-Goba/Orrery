import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Gate } from "./Gate";
import { login, signup } from "../auth/session";

vi.mock("../auth/session", () => ({
  login: vi.fn(),
  signup: vi.fn(),
}));

describe("Gate", () => {
  beforeEach(() => {
    vi.mocked(login).mockReset();
    vi.mocked(signup).mockReset();
  });

  it("shows an error and does not call onEnter for an empty username", () => {
    const onEnter = vi.fn();
    render(<Gate variant="login" onEnter={onEnter} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /warp home/i }));

    expect(screen.getByText("Every traveler needs a name.")).toBeInTheDocument();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("logs in through real auth and fires onEnter", async () => {
    vi.mocked(login).mockResolvedValue({
      username: "nova",
      displayName: "Nova",
      role: "voyager",
      isOwner: false,
      storageUsedBytes: 0,
      storageQuotaBytes: 1,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const onEnter = vi.fn();
    render(<Gate variant="login" onEnter={onEnter} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "nova" } });
    fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "secretpassword" } });
    fireEvent.click(screen.getByRole("button", { name: /warp home/i }));

    await waitFor(() => expect(onEnter).toHaveBeenCalledWith("nova"));
    expect(login).toHaveBeenCalledWith("nova", "secretpassword");
  });

  it("signs up with an invite code", async () => {
    vi.mocked(signup).mockResolvedValue({
      username: "nova",
      displayName: "Nova",
      role: "voyager",
      isOwner: false,
      storageUsedBytes: 0,
      storageQuotaBytes: 1,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const onEnter = vi.fn();
    render(<Gate variant="signup" onEnter={onEnter} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "nova" } });
    fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "secretpassword" } });
    fireEvent.change(screen.getByPlaceholderText("invite code"), { target: { value: "letmein" } });
    fireEvent.click(screen.getByRole("button", { name: /ignite/i }));

    await waitFor(() => expect(onEnter).toHaveBeenCalledWith("nova"));
    expect(signup).toHaveBeenCalledWith("nova", "secretpassword", "letmein");
  });

  it("renders backend auth errors", async () => {
    vi.mocked(login).mockRejectedValue(new Error("nope"));
    const onEnter = vi.fn();
    render(<Gate variant="login" onEnter={onEnter} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "nova" } });
    fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "badpassword" } });
    fireEvent.click(screen.getByRole("button", { name: /warp home/i }));

    expect(await screen.findByText("The gate did not recognize that orbit.")).toBeInTheDocument();
    expect(onEnter).not.toHaveBeenCalled();
  });
});
