"use client"

// Small dependency-free SVG charts. Your admin sidebar already avoids an icon
// library; this keeps the same posture (no new bundle weight). Every chart has
// role="img" + aria-label, native <title> tooltips, and an empty state.
// Colors reuse existing admin/stone tokens; meaning never relies on color alone
// (legends carry text + values).

const SERIES = [
  { stroke: "stroke-admin-accent", fill: "fill-admin-accent", bg: "bg-admin-accent" },
  { stroke: "stroke-stone-500", fill: "fill-stone-500", bg: "bg-stone-500" },
  { stroke: "stroke-amber-600", fill: "fill-amber-600", bg: "bg-amber-600" },
  { stroke: "stroke-emerald-600", fill: "fill-emerald-600", bg: "bg-emerald-600" },
  { stroke: "stroke-stone-300", fill: "fill-stone-300", bg: "bg-stone-300" },
]

function Empty() {
  return <p className="py-10 text-center text-sm text-stone-500">No data in this period.</p>
}

function Legend({ items }: { items: { name: string; idx: number; value?: string }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
      {items.map((i) => (
        <li key={i.name} className="flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-sm ${SERIES[i.idx % SERIES.length].bg}`} aria-hidden />
          {i.name}
          {i.value != null && <span className="font-medium text-stone-900">{i.value}</span>}
        </li>
      ))}
    </ul>
  )
}

export function LineChart({
  series, labels, label,
}: { series: { name: string; values: number[] }[]; labels: string[]; label: string }) {
  const max = Math.max(0, ...series.flatMap((s) => s.values))
  if (labels.length === 0 || max === 0) return <Empty />
  const W = 600, H = 180, L = 32, R = 8, T = 8, B = 22
  const n = labels.length
  const x = (i: number) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1))
  const y = (v: number) => T + (1 - v / max) * (H - T - B)
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(max * t)} y2={y(max * t)} className="stroke-stone-200" />
            <text x={L - 4} y={y(max * t) + 3} textAnchor="end" className="fill-stone-500 text-[10px]">
              {Math.round(max * t)}
            </text>
          </g>
        ))}
        <text x={L} y={H - 6} className="fill-stone-500 text-[10px]">{labels[0].slice(5)}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="fill-stone-500 text-[10px]">{labels[n - 1].slice(5)}</text>
        {series.map((s, si) => (
          <g key={s.name}>
            <polyline
              fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              className={SERIES[si % SERIES.length].stroke}
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
            />
            {n <= 45 && s.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={5} className={`${SERIES[si % SERIES.length].fill} opacity-0 hover:opacity-100`}>
                <title>{`${s.name}, ${labels[i]}: ${v}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <Legend items={series.map((s, i) => ({ name: s.name, idx: i }))} />
    </div>
  )
}

export function BarChart({ data, label }: { data: { label: string; value: number }[]; label: string }) {
  const max = Math.max(0, ...data.map((d) => d.value))
  if (data.length === 0 || max === 0) return <Empty />
  const W = 600, H = 160, L = 28, B = 20, T = 6
  const slot = (W - L) / data.length
  const step = Math.ceil(data.length / 12)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
      <line x1={L} x2={W} y1={H - B} y2={H - B} className="stroke-stone-200" />
      <text x={L - 4} y={T + 8} textAnchor="end" className="fill-stone-500 text-[10px]">{max}</text>
      <text x={L - 4} y={H - B} textAnchor="end" className="fill-stone-500 text-[10px]">0</text>
      {data.map((d, i) => {
        const h = (d.value / max) * (H - B - T)
        return (
          <g key={d.label + i}>
            <rect x={L + i * slot + slot * 0.15} y={H - B - h} width={slot * 0.7} height={h} rx={2} className="fill-admin-accent">
              <title>{`${d.label}: ${d.value}`}</title>
            </rect>
            {i % step === 0 && (
              <text x={L + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="fill-stone-500 text-[10px]">{d.label}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export function Donut({ data, label }: { data: { label: string; value: number }[]; label: string }) {
  const parts = data.filter((d) => d.value > 0)
  const total = parts.reduce((a, d) => a + d.value, 0)
  if (total === 0) return <Empty />
  const r = 40, c = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row">
      <svg viewBox="0 0 100 100" role="img" aria-label={label} className="h-32 w-32 shrink-0 -rotate-90">
        {parts.map((d, i) => {
          const len = (d.value / total) * c
          const el = (
            <circle key={d.label} cx="50" cy="50" r={r} fill="none" strokeWidth="14"
              className={SERIES[i % SERIES.length].stroke}
              strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}>
              <title>{`${d.label}: ${d.value} (${Math.round((d.value / total) * 100)}%)`}</title>
            </circle>
          )
          offset += len
          return el
        })}
      </svg>
      <Legend items={parts.map((d, i) => ({ name: d.label, idx: i, value: `${d.value} (${Math.round((d.value / total) * 100)}%)` }))} />
    </div>
  )
}

export function HBars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(0, ...data.map((d) => d.value))
  if (data.length === 0 || max === 0) return <Empty />
  return (
    <ul className="space-y-2">
      {data.map((d) => (
        <li key={d.label} className="text-sm">
          <div className="flex justify-between gap-2">
            <span className="truncate text-stone-700">{d.label}</span>
            <span className="font-medium tabular-nums text-stone-900">{d.value}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-stone-100" aria-hidden>
            <div className="h-1.5 rounded-full bg-admin-accent" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}
