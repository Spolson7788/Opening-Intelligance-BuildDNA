import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { Opening } from "../lib/api";

const BUCKETS = [
  { label: "0-24", min: 0, max: 24, color: "#c93838" },
  { label: "25-49", min: 25, max: 49, color: "#c93838" },
  { label: "50-74", min: 50, max: 74, color: "#b8790f" },
  { label: "75-89", min: 75, max: 89, color: "#2f8f47" },
  { label: "90-100", min: 90, max: 100, color: "#2f8f47" },
];

export function HealthDistributionChart({ openings }: { openings: Opening[] }) {
  const data = BUCKETS.map((b) => ({
    label: b.label,
    count: openings.filter((o) => o.health_score !== null && o.health_score >= b.min && o.health_score <= b.max).length,
    color: b.color,
  }));

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--text-secondary)" }} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
        <YAxis tick={{ fontSize: 12, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{ fontSize: 13, borderRadius: 6, border: "1px solid var(--border)" }}
          formatter={(value) => [`${value} openings`, "Count"]}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
