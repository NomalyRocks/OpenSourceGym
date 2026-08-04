import type { MyWeightHistoryResponse } from "@opengym/shared";
import { api } from "./api";
import type { WeightEntry } from "./weightResolve";

export async function fetchWeightHistory(): Promise<WeightEntry[]> {
  const result = await api<MyWeightHistoryResponse>("/api/me/weight-history");
  return result.entries;
}
