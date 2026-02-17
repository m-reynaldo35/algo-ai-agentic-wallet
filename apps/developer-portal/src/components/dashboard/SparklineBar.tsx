"use client";

interface SparklineBarProps {
  data: { label: string; value: number }[];
  color?: string;
}

export default function SparklineBar({ data, color = "bg-emerald-500" }: SparklineBarProps) {
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="flex items-end gap-2 h-24">
      {data.map((d) => (
        <div key={d.label} className="flex-1 flex flex-col items-center gap-1">
          <div className="w-full flex items-end justify-center" style={{ height: "72px" }}>
            <div
              className={`w-full max-w-8 rounded-sm ${color} transition-all`}
              style={{ height: `${(d.value / max) * 100}%`, minHeight: "2px" }}
            />
          </div>
          <span className="text-[10px] text-zinc-500">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
