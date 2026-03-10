// Re-export shared types from the repository layer so feature internals
// and tests can import from one place without direct data-layer coupling.
export type { InjuryStatus, InjuryWithPlayer } from "../../../data/repositories/injuriesRepo";
