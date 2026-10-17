import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import type { Gym } from "@opengym/shared";
import { api } from "./api";

interface GymsState {
  /** Gyms the signed-in account may see (owner: all; admin/staff: scope). */
  gyms: Gym[];
  loading: boolean;
  refresh: () => Promise<void>;
}

const GymsContext = createContext<GymsState>({
  gyms: [],
  loading: true,
  refresh: async () => {},
});

export function GymsProvider({ children }: { children: React.ReactNode }) {
  const [gyms, setGyms] = useState<Gym[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setGyms(await api<Gym[]>("/api/admin/gyms"));
    } catch {
      setGyms([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ gyms, loading, refresh }),
    [gyms, loading, refresh],
  );
  return <GymsContext.Provider value={value}>{children}</GymsContext.Provider>;
}

export function useGyms(): GymsState {
  return useContext(GymsContext);
}

/** The gym selected in the URL (`/gyms/:gymId/...`). Only valid under that route. */
export function useGymId(): string {
  const { gymId } = useParams();
  if (!gymId) throw new Error("useGymId used outside /gyms/:gymId");
  return gymId;
}

/** Builds `/api/admin/gyms/:gymId<suffix>` for the selected gym. */
export function useGymApi(): (suffix: string) => string {
  const gymId = useGymId();
  return useCallback(
    (suffix: string) => `/api/admin/gyms/${encodeURIComponent(gymId)}${suffix}`,
    [gymId],
  );
}

/** Builds an in-app link `/gyms/:gymId<suffix>` for the selected gym. */
export function useGymLink(): (suffix: string) => string {
  const gymId = useGymId();
  return useCallback(
    (suffix: string) => `/gyms/${encodeURIComponent(gymId)}${suffix}`,
    [gymId],
  );
}

export const LAST_GYM_KEY = "opengym:lastGymId";

/** Picks the gym to open when the URL names none (or an unknown one). */
export function useDefaultGymId(): string | null {
  const { gyms } = useGyms();
  const last = localStorage.getItem(LAST_GYM_KEY);
  const remembered = gyms.find((g) => g.id === last);
  return (remembered ?? gyms.find((g) => g.active) ?? gyms[0])?.id ?? null;
}
