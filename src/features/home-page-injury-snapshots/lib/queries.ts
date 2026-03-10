import { useQuery } from "@tanstack/react-query";
import {
  getLatestInjuries,
  getCurrentlyInjured,
  getReturningSoon,
} from "../../../data/repositories/injuriesRepo";
import type { InjuryWithPlayer } from "./types";

export function useLatestInjuries({ limit = 10 } = {}) {
  return useQuery<InjuryWithPlayer[]>({
    queryKey: ["latest-injuries", limit],
    queryFn: () => getLatestInjuries(limit),
    staleTime: 60_000,
  });
}

export function useCurrentlyInjured({ limit = 10 } = {}) {
  return useQuery<InjuryWithPlayer[]>({
    queryKey: ["currently-injured", limit],
    queryFn: () => getCurrentlyInjured(limit),
    staleTime: 60_000,
  });
}

export function useReturningSoon({ limit = 10, windowDays = 14 } = {}) {
  return useQuery<InjuryWithPlayer[]>({
    queryKey: ["returning-soon", limit, windowDays],
    queryFn: () => getReturningSoon(limit, windowDays),
    staleTime: 60_000,
  });
}
