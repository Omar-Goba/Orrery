import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IngestOrbIndicator } from "./IngestOrbIndicator";

describe("IngestOrbIndicator", () => {
  it.each([
    [0, "arrival"],
    [30, "survey"],
    [70, "narrowing"],
    [90, "holding"],
    [100, "holding"],
  ] as const)("presents %s%% as the %s phase", (pct, phase) => {
    const { container } = render(
      <IngestOrbIndicator step={`Progress ${pct}`} pct={pct} reducedMotion={false} />,
    );
    expect(container.firstElementChild).toHaveAttribute("data-ingest-phase", phase);
  });

  it("is entirely decorative and does not duplicate external progress text", () => {
    const { container } = render(
      <div>
        <IngestOrbIndicator step="Embedding chunks" pct={45} reducedMotion={false} />
        <span>Embedding chunks</span>
        <span>45%</span>
      </div>,
    );
    const indicator = container.querySelector("[data-ingest-phase]");
    expect(indicator).toHaveAttribute("aria-hidden", "true");
    expect(indicator?.querySelector("svg")).toHaveAttribute("focusable", "false");
    expect(screen.getAllByText("Embedding chunks")).toHaveLength(1);
    expect(screen.getByText("45%")).toBeInTheDocument();
  });

  it("uses restrained animation for normal motion", () => {
    render(<IngestOrbIndicator step="Surveying" pct={50} reducedMotion={false} />);
    expect(screen.getByTestId("ingest-orbit")).toHaveClass("animate-spin");
    expect(screen.getByTestId("ingest-core-glow")).toHaveClass("animate-pulse");
  });

  it("renders a static phase glyph for reduced motion", () => {
    const { container } = render(
      <IngestOrbIndicator step="Narrowing" pct={75} reducedMotion className="custom-class" />,
    );
    const indicator = container.querySelector("[data-ingest-phase]");
    expect(indicator).toHaveAttribute("data-reduced-motion", "true");
    expect(indicator).toHaveClass("custom-class");
    expect(screen.getByTestId("ingest-orbit")).not.toHaveClass("animate-spin");
    expect(screen.getByTestId("ingest-core-glow")).not.toHaveClass("animate-pulse");
  });
});
