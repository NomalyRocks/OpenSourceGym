import { useEffect, useState } from "react";

/**
 * Current time that re-renders the caller every `intervalMs`. Lets "minutes
 * inside" labels advance without refetching the underlying data.
 */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
