import { getMe, loginAuth, logoutAuth, signupAuth, type AuthUser } from "../api/client";
import { readJSON, writeJSON } from "../lib/storage";

export const OWNER_USERNAME = "omar";
const KEY = "orrery.session";

export interface Session {
  username: string;
  displayName: string;
  role: "keeper" | "voyager";
  isOwner: boolean;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  createdAt: string;
}

export type GalaxyMode = "owner" | "observer";

function sessionFromUser(user: AuthUser): Session {
  const session: Session = {
    username: user.handle,
    displayName: user.display_name,
    role: user.role,
    isOwner: user.role === "keeper",
    storageUsedBytes: user.storage_used_bytes,
    storageQuotaBytes: user.storage_quota_bytes,
    createdAt: user.created_at,
  };
  writeJSON(localStorage, KEY, session);
  return session;
}

export async function login(username: string, password: string): Promise<Session> {
  const user = await loginAuth(username.trim().toLowerCase(), password);
  return sessionFromUser(user);
}

export async function signup(
  username: string,
  password: string,
  inviteCode?: string,
): Promise<Session> {
  const user = await signupAuth(username.trim().toLowerCase(), password, inviteCode);
  return sessionFromUser(user);
}

export async function refreshSession(): Promise<Session | null> {
  try {
    return sessionFromUser(await getMe());
  } catch {
    localStorage.removeItem(KEY);
    return null;
  }
}

export function getSession(): Session | null {
  return readJSON<Session>(localStorage, KEY);
}

export async function logout(): Promise<void> {
  try {
    await logoutAuth();
  } finally {
    localStorage.removeItem(KEY);
  }
}
