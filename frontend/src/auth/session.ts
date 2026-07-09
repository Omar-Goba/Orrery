export const OWNER_USERNAME = "omar";
const KEY = "orrery.session";

export interface Session {
  username: string;
  isOwner: boolean;
  createdAt: string;
}

export type GalaxyMode = "owner" | "observer";

// Fake auth: any non-empty username/password pair is accepted. This is
// intentional theater for the demo — see docs/md/ORRERY_UI_PLAN.md §12 for
// the real-auth boundary this file will grow into.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- password kept in the signature to document the fake-auth contract
export function login(username: string, _password: string): Session {
  const u = username.trim().toLowerCase();
  const session: Session = {
    username: u,
    isOwner: u === OWNER_USERNAME,
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(KEY, JSON.stringify(session));
  return session;
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function logout(): void {
  localStorage.removeItem(KEY);
}
