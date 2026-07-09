import { useState } from "react";
import { X } from "lucide-react";
import { login } from "../auth/session";

export function Gate({
  variant,
  onEnter,
  onClose,
}: {
  variant: "login" | "signup";
  onEnter: (username: string) => void;
  onClose: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isLogin = variant === "login";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError("Every traveler needs a name.");
      return;
    }
    const session = login(username, password);
    onEnter(session.username);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/60 backdrop-blur-sm animate-fade-up">
      <div className="relative w-[320px] rounded-2xl glass p-6 shadow-panel">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-lg p-1.5 text-muted hover:bg-rim hover:text-ink transition-colors"
        >
          <X size={14} />
        </button>

        <h2 className="text-sm font-semibold tracking-tight text-ink">
          {isLogin ? "Return to your galaxy" : "Ignite a new universe"}
        </h2>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <div className="flex items-center gap-2 rounded-lg border border-rim bg-bg/60 px-2.5 py-1.5 focus-within:border-cyan-500/40">
            <input
              value={username}
              onChange={e => { setUsername(e.target.value); setError(null); }}
              placeholder="username"
              autoFocus
              className="w-full bg-transparent text-[12px] text-ink placeholder:text-muted outline-none"
            />
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-rim bg-bg/60 px-2.5 py-1.5 focus-within:border-cyan-500/40">
            <input
              value={password}
              onChange={e => { setPassword(e.target.value); setError(null); }}
              placeholder="password"
              type="password"
              className="w-full bg-transparent text-[12px] text-ink placeholder:text-muted outline-none"
            />
          </div>

          {error && <p className="text-[11px] text-amber-400">{error}</p>}

          <button
            type="submit"
            className="w-full rounded-lg bg-cyan-500/15 px-3 py-2 text-[12px] font-semibold text-cyan-400 hover:bg-cyan-500/25 transition-colors"
          >
            {isLogin ? "Warp home" : "Ignite"}
          </button>
        </form>

        <p className="mt-4 text-[10px] text-muted">
          Auth is in preview — any credentials work for now.
        </p>
      </div>
    </div>
  );
}
