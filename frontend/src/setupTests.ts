import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement ResizeObserver; StarfieldCanvas/PaperGraph use it
// to size their canvases, so stub it globally for the test environment.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;
