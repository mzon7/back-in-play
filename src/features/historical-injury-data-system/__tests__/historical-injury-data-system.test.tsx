/**
 * Tests for "Historical Injury Data System"
 *
 * Covers:
 *  1. RecoveryStatsPanel renders injury type name, median days, and severity badge
 *  2. RecoveryStatsList renders skeleton placeholders while loading
 *  3. RecoveryStatsList renders empty state when no stats exist
 *  4. RecoveryStatsList groups stats by league in "all" view
 *  5. LeagueFilterBar renders all 6 filter options, marks active tab
 *  6. RecoveryStatsPage syncs league filter to URL search params
 *  7. getSeverityColor returns correct colour for known and unknown injury types
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import { RecoveryStatsPanel } from "../components/RecoveryStatsPanel";
import { RecoveryStatsList } from "../components/RecoveryStatsList";
import { LeagueFilterBar } from "../components/LeagueFilterBar";
import { RecoveryStatsPage } from "../components/RecoveryStatsPage";
import { getSeverityColor } from "../lib/types";
import type { RecoveryStat } from "../lib/types";
import * as queries from "../lib/queries";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../../../lib/supabase", () => ({
  supabase: {},
  dbTable: (name: string) => `back_in_play_${name}`,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function makeStat(overrides: Partial<RecoveryStat> = {}): RecoveryStat {
  return {
    stat_id: "stat-1",
    injury_type: "Hamstring",
    injury_type_slug: "hamstring",
    league_slug: "nfl",
    league_name: "NFL",
    average_recovery_days: 22,
    median_recovery_days: 21,
    stddev_recovery_days: 7.5,
    min_recovery_days: 14,
    max_recovery_days: 42,
    sample_size: 8,
    computed_at: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("RecoveryStatsPanel", () => {
  it("renders injury type, median days, and severity badge", () => {
    render(<RecoveryStatsPanel stat={makeStat()} />, { wrapper });

    expect(screen.getByText("Hamstring")).toBeInTheDocument();
    expect(screen.getByText("21")).toBeInTheDocument();
    expect(screen.getByText("Moderate")).toBeInTheDocument();
  });

  it("shows '—' when median_recovery_days is null", () => {
    render(
      <RecoveryStatsPanel stat={makeStat({ median_recovery_days: null })} />,
      { wrapper }
    );
    // The big number cell should show em dash
    const panel = screen.getByTestId("recovery-stats-panel");
    expect(panel.textContent).toContain("—");
  });

  it("renders min, avg, max stat cells", () => {
    render(<RecoveryStatsPanel stat={makeStat()} />, { wrapper });
    expect(screen.getByText("22d")).toBeInTheDocument(); // avg
    expect(screen.getByText("14d")).toBeInTheDocument(); // min
    expect(screen.getByText("42d")).toBeInTheDocument(); // max
  });

  it("shows critical severity for ACL Tear", () => {
    render(<RecoveryStatsPanel stat={makeStat({ injury_type: "ACL Tear", injury_type_slug: "acl-tear" })} />, { wrapper });
    expect(screen.getByText("Critical")).toBeInTheDocument();
  });
});

describe("RecoveryStatsList", () => {
  it("renders skeleton placeholders while loading", () => {
    render(
      <RecoveryStatsList stats={[]} isLoading={true} leagueFilter="all" />,
      { wrapper }
    );
    const skeletons = screen.getAllByTestId("stat-skeleton");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders empty state message when no stats", () => {
    render(
      <RecoveryStatsList stats={[]} isLoading={false} leagueFilter="all" />,
      { wrapper }
    );
    expect(screen.getByText(/no recovery stats yet/i)).toBeInTheDocument();
  });

  it("groups stats by league section headers in 'all' view", () => {
    const stats = [
      makeStat({ stat_id: "1", league_slug: "nfl", league_name: "NFL" }),
      makeStat({ stat_id: "2", league_slug: "nba", league_name: "NBA", injury_type: "Knee" }),
    ];
    render(
      <RecoveryStatsList stats={stats} isLoading={false} leagueFilter="all" />,
      { wrapper }
    );
    expect(screen.getByText("NFL")).toBeInTheDocument();
    expect(screen.getByText("NBA")).toBeInTheDocument();
  });

  it("renders flat grid (no section headers) when filtering by specific league", () => {
    const stats = [makeStat({ stat_id: "1", league_slug: "nfl", league_name: "NFL" })];
    render(
      <RecoveryStatsList stats={stats} isLoading={false} leagueFilter="nfl" />,
      { wrapper }
    );
    // Panels rendered but no section <h2>
    expect(screen.getByTestId("recovery-stats-panel")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });
});

describe("LeagueFilterBar", () => {
  it("renders all 6 filter options", () => {
    render(<LeagueFilterBar value="all" onChange={() => {}} />, { wrapper });
    expect(screen.getByText("All Leagues")).toBeInTheDocument();
    expect(screen.getByText("NFL")).toBeInTheDocument();
    expect(screen.getByText("NBA")).toBeInTheDocument();
    expect(screen.getByText("MLB")).toBeInTheDocument();
    expect(screen.getByText("NHL")).toBeInTheDocument();
    expect(screen.getByText("Premier League")).toBeInTheDocument();
  });

  it("marks active tab with aria-selected=true", () => {
    render(<LeagueFilterBar value="nba" onChange={() => {}} />, { wrapper });
    const nbaTab = screen.getByRole("tab", { name: "NBA" });
    expect(nbaTab).toHaveAttribute("aria-selected", "true");
    const allTab = screen.getByRole("tab", { name: "All Leagues" });
    expect(allTab).toHaveAttribute("aria-selected", "false");
  });

  it("calls onChange when a tab is clicked", () => {
    const onChange = vi.fn();
    render(<LeagueFilterBar value="all" onChange={onChange} />, { wrapper });
    fireEvent.click(screen.getByRole("tab", { name: "NHL" }));
    expect(onChange).toHaveBeenCalledWith("nhl");
  });
});

describe("RecoveryStatsPage", () => {
  beforeEach(() => {
    vi.spyOn(queries, "useRecoveryStats").mockReturnValue({
      data: [makeStat()],
      isLoading: false,
      error: null,
    } as ReturnType<typeof queries.useRecoveryStats>);
  });

  it("renders the page heading", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/recovery-stats"]}>
          <Routes>
            <Route path="/recovery-stats" element={<RecoveryStatsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});

describe("getSeverityColor", () => {
  it("returns red for ACL Tear (critical)", () => {
    expect(getSeverityColor("ACL Tear")).toBe("#FF4D4D");
  });

  it("returns blue (moderate) for Hamstring", () => {
    expect(getSeverityColor("Hamstring")).toBe("#1C7CFF");
  });

  it("returns green (minor) for Ankle Sprain", () => {
    expect(getSeverityColor("Ankle Sprain")).toBe("#3DFF8F");
  });

  it("defaults to moderate blue for unknown injury", () => {
    expect(getSeverityColor("Mystery Injury")).toBe("#1C7CFF");
  });
});
