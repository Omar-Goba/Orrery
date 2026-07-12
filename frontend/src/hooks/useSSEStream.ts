import { useEffect, useRef } from "react";

type Subscribe = () => (() => void) | void;

export function useSSEStream() {
  const cleanupRef = useRef<(() => void) | null>(null);

  const cancel = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  };

  const start = (subscribe: Subscribe) => {
    cancel();
    cleanupRef.current = subscribe() ?? null;
  };

  useEffect(() => () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  return { start, cancel };
}
