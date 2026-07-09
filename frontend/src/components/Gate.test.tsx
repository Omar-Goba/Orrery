import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Gate } from "./Gate";
import { getSession } from "../auth/session";

describe("Gate", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows an error and does not call onEnter for an empty username", () => {
    const onEnter = vi.fn();
    render(<Gate variant="login" onEnter={onEnter} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /warp home/i }));

    expect(screen.getByText("Every traveler needs a name.")).toBeInTheDocument();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("logs in and fires onEnter for a non-empty username/password", () => {
    const onEnter = vi.fn();
    render(<Gate variant="signup" onEnter={onEnter} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("username"), { target: { value: "nova" } });
    fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /ignite/i }));

    expect(onEnter).toHaveBeenCalledWith("nova");
    expect(getSession()).toMatchObject({ username: "nova", isOwner: false });
  });
});
