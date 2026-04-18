import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { SessionResponse, UserPublic } from "@app/shared";
import { api } from "./api";

/**
 * Mock auth for local dev. Set VITE_MOCK_AUTH=1 in client/.env.local and ANY
 * email/password will succeed; the fake user persists to localStorage so
 * refreshes stay logged in. Off in production and when a real backend exists.
 */
const MOCK_AUTH = import.meta.env.VITE_MOCK_AUTH === "1";
const MOCK_KEY = "nontrivial.mock.user";

function readMockUser(): UserPublic | null {
  try {
    const raw = localStorage.getItem(MOCK_KEY);
    return raw ? (JSON.parse(raw) as UserPublic) : null;
  } catch {
    return null;
  }
}

function writeMockUser(u: UserPublic | null) {
  try {
    if (u) localStorage.setItem(MOCK_KEY, JSON.stringify(u));
    else localStorage.removeItem(MOCK_KEY);
  } catch {
    // ignore
  }
}

function fakeUser(email: string, name?: string): UserPublic {
  return {
    id: `mock-${email}`,
    email,
    name: name ?? email.split("@")[0] ?? "You",
    image: null,
  };
}

interface AuthCtx {
  user: UserPublic | null;
  loading: boolean;
  signup: (email: string, password: string, name?: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (MOCK_AUTH) {
      setUser(readMockUser());
      setLoading(false);
      return;
    }
    api
      .get<SessionResponse>("/api/auth/session")
      .then((s) => setUser(s.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const signup: AuthCtx["signup"] = async (email, password, name) => {
    if (MOCK_AUTH) {
      if (!email.includes("@")) throw new Error("Enter a valid email");
      if (password.length < 8) throw new Error("Password too short");
      const u = fakeUser(email, name);
      writeMockUser(u);
      setUser(u);
      return;
    }
    const { user } = await api.post<{ user: UserPublic }>("/api/auth/signup", { email, password, name });
    setUser(user);
  };

  const login: AuthCtx["login"] = async (email, password) => {
    if (MOCK_AUTH) {
      if (!email.includes("@")) throw new Error("Enter a valid email");
      if (password.length < 1) throw new Error("Enter a password");
      const u = fakeUser(email);
      writeMockUser(u);
      setUser(u);
      return;
    }
    const { user } = await api.post<{ user: UserPublic }>("/api/auth/login", { email, password });
    setUser(user);
  };

  const logout = async () => {
    if (MOCK_AUTH) {
      writeMockUser(null);
      setUser(null);
      return;
    }
    await api.post("/api/auth/logout");
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, signup, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be inside <AuthProvider>");
  return v;
}
