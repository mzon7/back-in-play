/**
 * Regression tests for "Historical Injury Data System"
 *
 * Covers:
 *  1.  predictReturnDate: adds median days to injury date correctly (happy path)
 *  2.  predictReturnDate: rounds fractional median days before adding
 *  3.  predictReturnDate: handles long recovery (ACL — 275 days)
 *  4.  predictReturnDateFromStat: returns null when stat is null
 *  5.  predictReturnDateFromStat: returns null when median_recovery_days is null
 *  6.  predictReturnDateFromStat: returns correct date when stat is valid
 *  7.  getSeverityColor: critical injury returns red
 *  8.  getSeverityColor: minor injury returns green
 *  9.  getSeverityColor: unknown injury defaults to moderate (blue)
 *  10. RecoveryStatsPanel: renders sample size with correct singular/plural label
 *  11. RecoveryStatsPanel: rounds fractional average to integer in display
 *  12. RecoveryStatsPage: shows error banner when query fails
 *  13. RecoveryStatsPage: pre-selects league tab from ?league= URL param
 *  14. RecoveryStatsList: all leagues appear as section headers in "all" view for 5-league data
 *  15. LeagueFilterBar: switching tab updates aria-selected immediately
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import {
  getSeverityColor,
  predictReturnDate,
  predictReturnDateFromStat,
} from "../../features/historical-injury-data-system/lib/types";
import type { RecoveryStat } from "../../features/historical-injury-data-system/lib/types";
import { RecoveryStatsPanel } from "../../features/historical-injury-data-system/components/RecoveryStatsPanel";
import { RecoveryStatsList } from "../../features/historical-injury-data-system/components/RecoveryStatsList";
import { LeagueFilterBar } from "../../features/historical-injury-data-system/components/LeagueFilterBar";
import { RecoveryStatsPage } from "../../features/historical-injury-data-system/components/RecoveryStatsPage";
import * as queries from "../../features/historical-injury-data-system/lib/queries";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../lib/supabase", () => ({
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

function renderPage(initialPath = "/recovery-stats") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/recovery-stats" element={<RecoveryStatsPage />} />
        </Routes>
      </MemoryRouter>
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
    average_recovery_days: 22.6,
    median_recovery_days: 21,
    stddev_recovery_days: 7.5,
    min_recovery_days: 14,
    max_recovery_days: 42,
    sample_size: 8,
    computed_at: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

const LEAGUE_SLUGS = ["nfl", "nba", "mlb", "nhl", "premier-league"] as const;
const LEAGUE_NAMES: Record<string, string> = {
  nfl: "NFL",
  nba: "NBA",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "Premier League",
};

// ─── 1–3: predictReturnDate ───────────────────────────────────────────────────

describe("predictReturnDate", () => {
  it("adds median days to injury date correctly (happy path)", () => {
    // 14 days after 2025-01-01 = 2025-01-15
    expect(predictReturnDate("2025-01-01", 14)).toBe("2025-01-15");
  });

  it("rounds fractional median days before adding", () => {
    // 21.7 rounds to 22, 22 days after 2025-03-01 = 2025-03-23
    expect(predictReturnDate("2025-03-01", 21.7)).toBe("2025-03-23");
  });

  it("handles long ACL recovery of 275 days", () => {
    // 275 days after 2024-01-01
    const result = predictReturnDate("2024-01-01", 275);
    // Should be 2024-10-02 (275 days later)
    const expected = new Date(new Date("2024-01-01").getTime() + 275 * 86400000)
      .toISOString()
      .split("T")[0];
    expect(result).toBe(expected);
  });
});

// ─── 4–6: predictReturnDateFromStat ──────────────────────────────────────────

describe("predictReturnDateFromStat", () => {
  it("returns null when stat is null", () => {
    expect(predictReturnDateFromStat("2025-01-01", null)).toBeNull();
  });

  it("returns null when median_recovery_days is null", () => {
    expect(
      predictReturnDateFromStat("2025-01-01", makeStat({ median_recovery_days: null }))
    ).toBeNull();
  });

  it("returns correct predicted return date when stat is valid", () => {
    const stat = makeStat({ median_recovery_days: 21 });
    // 21 days after 2025-06-01 = 2025-06-22
    expect(predictReturnDateFromStat("2025-06-01", stat)).toBe("2025-06-22");
  });
});

// ─── 7–9: getSeverityColor ────────────────────────────────────────────────────

describe("getSeverityColor", () => {
  it("returns red (#FF4D4D) for critical injuries (ACL Tear)", () => {
    expect(getSeverityColor("ACL Tear")).toBe("#FF4D4D");
  });

  it("returns green (#3DFF8F) for minor injuries (Ankle Sprain, Calf, Wrist)", () => {
    expect(getSeverityColor("Ankle Sprain")).toBe("#3DFF8F");
    expect(getSeverityColor("Calf")).toBe("#3DFF8F");
    expect(getSeverityColor("Wrist")).toBe("#3DFF8F");
  });

  it("defaults to moderate blue (#1C7CFF) for unknown injury type", () => {
    expect(getSeverityColor("Mysterious Tweak")).toBe("#1C7CFF");
  });
});

// ─── 10–11: RecoveryStatsPanel edge cases ────────────────────────────────────

describe("RecoveryStatsPanel — edge cases", () => {
  it("shows 'record' (singular) when sample_size is 1", () => {
    render(<RecoveryStatsPanel stat={makeStat({ sample_size: 1 })} />, { wrapper });
    expect(screen.getByText("1 record")).toBeInTheDocument();
  });

  it("shows 'records' (plural) when sample_size > 1", () => {
    render(<RecoveryStatsPanel stat={makeStat({ sample_size: 5 })} />, { wrapper });
    expect(screen.getByText("5 records")).toBeInTheDocument();
  });

  it("rounds fractional average_recovery_days to integer in display", () => {
    // average_recovery_days = 22.6 → displayed as "23d"
    render(<RecoveryStatsPanel stat={makeStat({ average_recovery_days: 22.6 })} />, { wrapper });
    expect(screen.getByText("23d")).toBeInTheDocument();
  });

  it("shows '—' for all stat cells when all numeric fields are null", () => {
    render(
      <RecoveryStatsPanel
        stat={makeStat({
          median_recovery_days: null,
          average_recovery_days: null,
          min_recovery_days: null,
          max_recovery_days: null,
        })}
      />,
      { wrapper }
    );
    const panel = screen.getByTestId("recovery-stats-panel");
    // Multiple em-dashes expected
    const dashes = panel.textContent?.match(/—/g) ?? [];
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── 12–13: RecoveryStatsPage ────────────────────────────────────────────────

describe("RecoveryStatsPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows error banner when the query fails", () => {
    vi.spyOn(queries, "useRecoveryStats").mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Network error"),
    } as ReturnType<typeof queries.useRecoveryStats>);

    renderPage();
    expect(screen.getByText(/failed to load recovery stats/i)).toBeInTheDocument();
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });

  it("pre-selects the correct league tab from ?league= URL param", () => {
    vi.spyOn(queries, "useRecoveryStats").mockReturnValue({
      data: [makeStat({ league_slug: "nba", league_name: "NBA" })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof queries.useRecoveryStats>);

    renderPage("/recovery-stats?league=nba");
    // The NBA tab should be aria-selected
    const nbaTab = screen.getByRole("tab", { name: "NBA" });
    expect(nbaTab).toHaveAttribute("aria-selected", "true");
    const allTab = screen.getByRole("tab", { name: "All Leagues" });
    expect(allTab).toHaveAttribute("aria-selected", "false");
  });

  it("shows loading skeletons while isLoading=true", () => {
    vi.spyOn(queries, "useRecoveryStats").mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as ReturnType<typeof queries.useRecoveryStats>);

    renderPage();
    expect(screen.getAllByTestId("stat-skeleton").length).toBeGreaterThan(0);
  });
});

// ─── 14: RecoveryStatsList — all-league grouping ─────────────────────────────

describe("RecoveryStatsList — all-league grouping", () => {
  it("renders section headers for each of the 5 supported leagues", () => {
    const stats = LEAGUE_SLUGS.map((slug, i) =>
      makeStat({
        stat_id: `stat-${i}`,
        league_slug: slug,
        league_name: LEAGUE_NAMES[slug],
        injury_type: "Hamstring",
      })
    );

    render(
      <RecoveryStatsList stats={stats} isLoading={false} leagueFilter="all" />,
      { wrapper }
    );

    for (const name of Object.values(LEAGUE_NAMES)) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("renders multiple injury types within the same league section", () => {
    const stats = [
      makeStat({ stat_id: "1", injury_type: "Hamstring", league_slug: "nfl", league_name: "NFL" }),
      makeStat({ stat_id: "2", injury_type: "ACL Tear", injury_type_slug: "acl-tear", league_slug: "nfl", league_name: "NFL" }),
    ];

    render(
      <RecoveryStatsList stats={stats} isLoading={false} leagueFilter="all" />,
      { wrapper }
    );

    expect(screen.getAllByTestId("recovery-stats-panel")).toHaveLength(2);
    expect(screen.getAllByText("NFL")).toHaveLength(1); // Only one league section header
  });
});

// ─── 15: LeagueFilterBar — tab switching ─────────────────────────────────────

describe("LeagueFilterBar — tab switching", () => {
  it("updates aria-selected when a different tab is clicked", () => {
    let current: string = "all";
    const onChange = vi.fn((slug: string) => {
      current = slug;
    });

    const { rerender } = render(
      <LeagueFilterBar value="all" onChange={onChange} />,
      { wrapper }
    );

    fireEvent.click(screen.getByRole("tab", { name: "MLB" }));
    expect(onChange).toHaveBeenCalledWith("mlb");

    // Rerender with updated value (wrapper already provides Router context)
    rerender(<LeagueFilterBar value={current as "mlb"} onChange={onChange} />);

    expect(screen.getByRole("tab", { name: "MLB" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "All Leagues" })).toHaveAttribute("aria-selected", "false");
  });
});
