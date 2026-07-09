import { beforeEach, describe, expect, it } from "vitest";
import { getSession, login, logout, OWNER_USERNAME } from "./session";

describe("auth/session", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("accepts any non-empty credentials", () => {
    const session = login("nova", "anything");
    expect(session.username).toBe("nova");
  });

  it("marks omar as owner, case/whitespace-insensitively", () => {
    const session = login("  Omar ", "x");
    expect(session.username).toBe(OWNER_USERNAME);
    expect(session.isOwner).toBe(true);
  });

  it("marks anyone else as non-owner", () => {
    const session = login("vega-7", "x");
    expect(session.isOwner).toBe(false);
  });

  it("round-trips through localStorage", () => {
    login("nova", "x");
    const session = getSession();
    expect(session).not.toBeNull();
    expect(session?.username).toBe("nova");
  });

  it("returns null (not a throw) for no stored session", () => {
    expect(getSession()).toBeNull();
  });

  it("returns null (not a throw) for corrupt JSON in storage", () => {
    localStorage.setItem("orrery.session", "{not valid json");
    expect(getSession()).toBeNull();
  });

  it("logout clears the session", () => {
    login("nova", "x");
    logout();
    expect(getSession()).toBeNull();
  });
});
