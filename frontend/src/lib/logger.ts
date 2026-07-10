type ClientLogLevel = "warning" | "error";

interface ClientLogPayload {
  level: ClientLogLevel;
  message: string;
  stack?: string;
  url: string;
}

const MAX_LOGS_PER_SESSION = 20;
let sent = 0;

function postClientLog(payload: ClientLogPayload) {
  if (sent >= MAX_LOGS_PER_SESSION) return;
  sent += 1;

  fetch("/api/client-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  }).catch(() => {
    // Client logging must never affect the app path.
  });
}

function payload(level: ClientLogLevel, message: string, stack?: string): ClientLogPayload {
  return { level, message, stack, url: window.location.href };
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stackFrom(value: unknown): string | undefined {
  return value instanceof Error ? value.stack : undefined;
}

const nativeWarn = console.warn.bind(console);
const nativeError = console.error.bind(console);

console.warn = (...args: unknown[]) => {
  nativeWarn(...args);
  postClientLog(payload("warning", args.map(stringify).join(" "), stackFrom(args[0])));
};

console.error = (...args: unknown[]) => {
  nativeError(...args);
  postClientLog(payload("error", args.map(stringify).join(" "), stackFrom(args[0])));
};

window.addEventListener("error", (event) => {
  postClientLog(payload("error", event.message, event.error instanceof Error ? event.error.stack : undefined));
});

window.addEventListener("unhandledrejection", (event) => {
  postClientLog(payload("error", stringify(event.reason), stackFrom(event.reason)));
});
