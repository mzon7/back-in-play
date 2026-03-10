import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import HomePage from "./HomePage";
import * as queries from "../lib/queries";

// Stub Supabase to prevent network calls
vi.mock("../../../lib/supabase", () => ({
  supabase: {},
  dbTable: (name: string) => `back_in_play_${name}`,
}));

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("HomePage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders hero headline", () => {
    vi.spyOn(queries, "useLatestInjuries").mockReturnValue({ data: [], isLoading: false } as any);
    vi.spyOn(queries, "useCurrentlyInjured").mockReturnValue({ data: [], isLoading: false } as any);
    vi.spyOn(queries, "useReturningSoon").mockReturnValue({ data: [], isLoading: false } as any);

    render(<HomePage />, { wrapper: Wrapper });

    // h1 contains "Sports Injury" split across text nodes
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("renders three section cards", () => {
    vi.spyOn(queries, "useLatestInjuries").mockReturnValue({ data: [], isLoading: false } as any);
    vi.spyOn(queries, "useCurrentlyInjured").mockReturnValue({ data: [], isLoading: false } as any);
    vi.spyOn(queries, "useReturningSoon").mockReturnValue({ data: [], isLoading: false } as any);

    render(<HomePage />, { wrapper: Wrapper });

    // Section card titles are uppercase h2 elements
    const headings = screen.getAllByRole("heading", { level: 2 });
    const texts = headings.map((h) => h.textContent?.toUpperCase() ?? "");
    expect(texts.some((t) => t.includes("LATEST INJURIES"))).toBe(true);
    expect(texts.some((t) => t.includes("CURRENTLY INJURED"))).toBe(true);
    expect(texts.some((t) => t.includes("RETURNING SOON"))).toBe(true);
  });

  it("shows loading skeletons when queries are pending", () => {
    vi.spyOn(queries, "useLatestInjuries").mockReturnValue({ data: undefined, isLoading: true } as any);
    vi.spyOn(queries, "useCurrentlyInjured").mockReturnValue({ data: undefined, isLoading: true } as any);
    vi.spyOn(queries, "useReturningSoon").mockReturnValue({ data: undefined, isLoading: true } as any);

    const { container } = render(<HomePage />, { wrapper: Wrapper });

    // Skeletons use animate-pulse class
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no data", () => {
    vi.spyOn(queries, "useLatestInjuries").mockReturnValue({ data: [], isLoading: false } as any);
    vi.spyOn(queries, "useCurrentlyInjured").mockReturnValue({ data: [], isLoading: false } as any);
    vi.spyOn(queries, "useReturningSoon").mockReturnValue({ data: [], isLoading: false } as any);

    render(<HomePage />, { wrapper: Wrapper });

    // EmptyState titles rendered by each section
    expect(screen.getByText(/No injuries reported yet/i)).toBeTruthy();
    expect(screen.getByText(/No active injuries/i)).toBeTruthy();
    expect(screen.getByText(/No returns expected/i)).toBeTruthy();
  });

  it("renders player rows from useLatestInjuries data", () => {
    const fakeRow = {
      injury_id: "inj-1",
      player_id: "p-1",
      injury_type: "Hamstring",
      injury_type_slug: "hamstring",
      injury_description: null,
      date_injured: "2026-03-01",
      expected_recovery_range: "2-4 weeks",
      expected_return_date: "2026-03-20",
      status: "out" as const,
      back_in_play_players: {
        player_id: "p-1",
        player_name: "John Doe",
        slug: "john-doe-p-1",
        position: "WR",
        back_in_play_teams: {
          team_id: "t-1",
          team_name: "Kansas City Chiefs",
          back_in_play_leagues: {
            league_id: "l-1",
            league_name: "NFL",
            slug: "nfl",
          },
        },
      },
    };

    vi.spyOn(queries, "useLatestInjuries").mockReturnValue({ data: [fakeRow], isLoading: false } as any);
    vi.spyOn(queries, "useCurrentlyInjured").mockReturnValue({ data: [], isLoading: false } as any);
    vi.spyOn(queries, "useReturningSoon").mockReturnValue({ data: [], isLoading: false } as any);

    render(<HomePage />, { wrapper: Wrapper });

    expect(screen.getByText("John Doe")).toBeTruthy();
    expect(screen.getByText("Hamstring")).toBeTruthy();
  });
});
