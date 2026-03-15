import {
  ResponsiveContainer,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Line,
  ComposedChart,
} from "recharts";
import type { PerformanceCurve, ReturnCase, CurvePoint } from "../lib/types";

function buildChartData(
  curve: PerformanceCurve,
  playerCase?: ReturnCase | null
): CurvePoint[] {
  const points: CurvePoint[] = [];
  for (let i = 0; i < 10; i++) {
    const median = curve.median_pct_recent[i];
    const stderr = curve.stderr_pct_recent[i];

    const point: CurvePoint = {
      game: i + 1,
      label: `G${i + 1}`,
      avg: curve.avg_pct_recent[i] != null ? Math.round(curve.avg_pct_recent[i]! * 100) : null,
      median: median != null ? Math.round(median * 100) : null,
      p25: curve.p25_pct_recent[i] != null ? Math.round(curve.p25_pct_recent[i]! * 100) : null,
      p75: curve.p75_pct_recent[i] != null ? Math.round(curve.p75_pct_recent[i]! * 100) : null,
      minutesPct: curve.avg_minutes_pct[i] != null ? Math.round(curve.avg_minutes_pct[i]! * 100) : null,
      // Stderr bands (median ± 1 stderr)
      stddevUpper: median != null && stderr != null ? Math.round((median + stderr) * 100) : null,
      stddevLower: median != null && stderr != null ? Math.round((median - stderr) * 100) : null,
    };

    if (playerCase) {
      const composites = Array.isArray(playerCase.post_game_composites)
        ? playerCase.post_game_composites
        : (playerCase.post_game_composites as any)?.games ?? [];
      const entry = composites.find((e: any) => e.game_num === i + 1);
      if (entry && playerCase.pre_baseline_5g && playerCase.pre_baseline_5g > 0) {
        point.playerPct = Math.round((entry.composite / playerCase.pre_baseline_5g) * 100);
      }
    }

    points.push(point);
  }
  return points;
}

export function PerformanceCurveChart({
  curve,
  playerCase,
  height = 280,
  compareCurve,
  compareLabel,
}: {
  curve: PerformanceCurve;
  playerCase?: ReturnCase | null;
  height?: number;
  compareCurve?: PerformanceCurve | null;
  compareLabel?: string;
}) {
  const data = buildChartData(curve, playerCase);

  // Merge comparison curve data
  if (compareCurve) {
    const compareData = buildChartData(compareCurve);
    for (let i = 0; i < data.length; i++) {
      (data[i] as any).compareMedian = compareData[i]?.median ?? null;
    }
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 10, right: 10, bottom: 5, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="label"
          tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: 500 }}
          axisLine={{ stroke: "rgba(255,255,255,0.15)" }}
          tickLine={false}
        />
        <YAxis
          domain={[0, 150]}
          tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: 500 }}
          axisLine={{ stroke: "rgba(255,255,255,0.15)" }}
          tickLine={false}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const labels: Record<string, string> = {
              median: "Median",
              avg: "Average",
              p25: "25th pctl",
              p75: "75th pctl",
              playerPct: "This player",
              stddevUpper: "Median + SE",
              stddevLower: "Median − SE",
              compareMedian: compareLabel ?? "Compare",
            };
            const colors: Record<string, string> = {
              median: "#1C7CFF",
              avg: "rgba(255,255,255,0.4)",
              p25: "rgba(28,124,255,0.35)",
              p75: "rgba(28,124,255,0.35)",
              playerPct: "#3DFF8F",
              stddevUpper: "rgba(28,124,255,0.25)",
              stddevLower: "rgba(28,124,255,0.25)",
              compareMedian: "#FF8C00",
            };
            // Show only lines the user cares about
            const show = ["median", "avg", "playerPct", "compareMedian"];
            const items = payload.filter((p) => show.includes(String(p.dataKey)) && p.value != null);
            return (
              <div style={{ background: "#0F1320", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, padding: "8px 12px", boxShadow: "0 4px 12px rgba(0,0,0,0.5)" }}>
                <p style={{ color: "rgba(255,255,255,0.8)", fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{label}</p>
                {items.map((entry) => {
                  const key = String(entry.dataKey);
                  const c = colors[key] ?? "rgba(255,255,255,0.6)";
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 2 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: c, flexShrink: 0 }} />
                      <span style={{ color: c, fontWeight: 500 }}>{labels[key] ?? key}:</span>
                      <span style={{ color: "rgba(255,255,255,0.9)", fontWeight: 600 }}>{entry.value}%</span>
                    </div>
                  );
                })}
              </div>
            );
          }}
        />

        {/* 100% baseline */}
        <ReferenceLine
          y={100}
          stroke="rgba(61,255,143,0.5)"
          strokeDasharray="6 4"
          label={{
            value: "Pre-injury baseline",
            position: "right",
            fill: "rgba(61,255,143,0.7)",
            fontSize: 11,
            fontWeight: 600,
          }}
        />

        {/* P25-P75 band */}
        <Area
          type="monotone"
          dataKey="p75"
          stroke="none"
          fill="rgba(28,124,255,0.12)"
          connectNulls
        />
        <Area
          type="monotone"
          dataKey="p25"
          stroke="none"
          fill="#0A0E1A"
          connectNulls
        />

        {/* Stderr band (tighter than p25/p75) */}
        <Area
          type="monotone"
          dataKey="stddevUpper"
          stroke="none"
          fill="rgba(28,124,255,0.08)"
          connectNulls
        />
        <Area
          type="monotone"
          dataKey="stddevLower"
          stroke="none"
          fill="#0A0E1A"
          connectNulls
        />

        {/* Median line */}
        <Line
          type="monotone"
          dataKey="median"
          stroke="#1C7CFF"
          strokeWidth={2.5}
          dot={{ fill: "#1C7CFF", r: 3 }}
          connectNulls
        />

        {/* Average line */}
        <Line
          type="monotone"
          dataKey="avg"
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={1}
          strokeDasharray="4 3"
          dot={false}
          connectNulls
        />

        {/* Player overlay */}
        {playerCase && (
          <Line
            type="monotone"
            dataKey="playerPct"
            stroke="#3DFF8F"
            strokeWidth={2}
            dot={{ fill: "#3DFF8F", r: 4, stroke: "#0A0E1A", strokeWidth: 2 }}
            connectNulls
          />
        )}

        {/* Comparison curve overlay */}
        {compareCurve && (
          <Line
            type="monotone"
            dataKey="compareMedian"
            name={compareLabel ?? "Compare"}
            stroke="#FF8C00"
            strokeWidth={2}
            strokeDasharray="6 3"
            dot={{ fill: "#FF8C00", r: 3, stroke: "#0A0E1A", strokeWidth: 1 }}
            connectNulls
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
