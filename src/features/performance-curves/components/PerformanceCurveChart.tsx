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
    const point: CurvePoint = {
      game: i + 1,
      label: `G${i + 1}`,
      avg: curve.avg_pct_recent[i] != null ? Math.round(curve.avg_pct_recent[i]! * 100) : null,
      median: curve.median_pct_recent[i] != null ? Math.round(curve.median_pct_recent[i]! * 100) : null,
      p25: curve.p25_pct_recent[i] != null ? Math.round(curve.p25_pct_recent[i]! * 100) : null,
      p75: curve.p75_pct_recent[i] != null ? Math.round(curve.p75_pct_recent[i]! * 100) : null,
      minutesPct: curve.avg_minutes_pct[i] != null ? Math.round(curve.avg_minutes_pct[i]! * 100) : null,
    };

    if (playerCase) {
      const entry = playerCase.post_game_composites.find((e) => e.game_num === i + 1);
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
}: {
  curve: PerformanceCurve;
  playerCase?: ReturnCase | null;
  height?: number;
}) {
  const data = buildChartData(curve, playerCase);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 10, right: 10, bottom: 5, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="label"
          tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }}
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          tickLine={false}
        />
        <YAxis
          domain={[0, 150]}
          tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 11 }}
          axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
          tickLine={false}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip
          contentStyle={{
            background: "#0F1320",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: "rgba(255,255,255,0.6)" }}
          formatter={(value: unknown, name: unknown) => {
            const labels: Record<string, string> = {
              median: "Median",
              avg: "Average",
              p25: "25th percentile",
              p75: "75th percentile",
              playerPct: "This player",
            };
            return [`${value}%`, labels[String(name)] ?? String(name)];
          }}
        />

        {/* 100% baseline */}
        <ReferenceLine
          y={100}
          stroke="rgba(61,255,143,0.3)"
          strokeDasharray="6 4"
          label={{
            value: "Pre-injury baseline",
            position: "right",
            fill: "rgba(61,255,143,0.4)",
            fontSize: 10,
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
      </ComposedChart>
    </ResponsiveContainer>
  );
}
