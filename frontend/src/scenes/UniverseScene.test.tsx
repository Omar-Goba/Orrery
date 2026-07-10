import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UniverseScene } from "./UniverseScene";
import type { Session } from "../auth/session";

vi.mock("../components/StarfieldCanvas", () => ({
  StarfieldCanvas: () => <div />,
}));

vi.mock("../api/client", () => ({
  getTourGalaxy: vi.fn().mockResolvedValue({ stars: 3, ignited: 1, constellations: 2 }),
}));

const keeper: Session = {
  username: "omar",
  displayName: "Omar",
  role: "keeper",
  isOwner: true,
  storageUsedBytes: 0,
  storageQuotaBytes: 100,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("UniverseScene", () => {
  it("enters Omar's authenticated galaxy when the Keeper is signed in", () => {
    const onVisitObserver = vi.fn();
    const onContinue = vi.fn();
    render(
      <UniverseScene
        session={keeper}
        onVisitObserver={onVisitObserver}
        onEnter={() => {}}
        onContinue={onContinue}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /enter your galaxy/i })[0]);

    expect(onContinue).toHaveBeenCalledWith("omar");
    expect(onVisitObserver).not.toHaveBeenCalled();
  });
});
