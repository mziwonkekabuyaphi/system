"use client"

// Small dependency-free SVG charts. Your admin sidebar already avoids an icon
// library; this keeps the same posture (no new bundle weight). Every chart has
// role="img" + aria-label, native <title> tooltips, and an empty state.
// Colours come from the admin theme names (accent, ink-muted, line, ...), so the
// charts follow the cream and the Rands dark theme alike. Meaning never relies
// on colour alone (legends carry text + values).

import { useId } from "react"

// `text` is what a gradient's currentColor resolves to (an SVG gradient takes its
// colour from where it is DEFINED, not from the shape that uses it).
const SERIES = [
  { stroke: "stroke-accent", fill: "fill-accent", bg: "bg-accent", text: "text-accent" },
  { stroke: "stroke-ink-muted", fill: "fill-ink-muted", bg: "bg-ink-muted", text: "text-ink-muted" },
  { stroke: "stroke-warn", fill: "fill-warn", bg: "bg-warn", text: "text-warn" },
  { stroke: "stroke-success", fill: "fill-success", bg: "bg-success", text: "text-success" },
  { stroke: "stroke-line-strong", fill: "fill-line-strong", bg: "bg-line-strong", text: "text-line-strong" },
]

function Empty() {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-muted">
      No data in this period.
    </div>
  )
}

function Legend({ items }: { items: { name: string; idx: number; value?: string }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-soft">
      {items.map((i) => (
        <li key={i.name} className="flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-full ${SERIES[i.idx % SERIES.length].bg}`} aria-hidden />
          {i.name}
          {i.value != null && <span className="font-medium tabular-nums text-ink">{i.value}</span>}
        </li>
      ))}
    </ul>
  )
}

export function LineChart({
  series, labels, label,
}: { series: { name: string; values: number[] }[]; labels: string[]; label: string }) {
  const uid = useId().replace(/:/g, "")
  const max = Math.max(0, ...series.flatMap((s) => s.values))
  if (labels.length === 0 || max === 0) return <Empty />
  const W = 600, H = 180, L = 32, R = 8, T = 8, B = 22
  const n = labels.length
  const x = (i: number) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1))
  const y = (v: number) => T + (1 - v / max) * (H - T - B)
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
        <defs>
          {series.map((s, si) => (
            <linearGradient key={s.name} id={`${uid}-a${si}`} x1="0" x2="0" y1="0" y2="1" className={SERIES[si % SERIES.length].text}>
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(max * t)} y2={y(max * t)} strokeDasharray={t === 0 ? undefined : "3 4"} className="stroke-line" />
            <text x={L - 4} y={y(max * t) + 3} textAnchor="end" className="fill-ink-muted text-[10px]">
              {Math.round(max * t)}
            </text>
          </g>
        ))}
        <text x={L} y={H - 6} className="fill-ink-muted text-[10px]">{labels[0].slice(5)}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="fill-ink-muted text-[10px]">{labels[n - 1].slice(5)}</text>
        {series.map((s, si) => {
          const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")
          const colour = SERIES[si % SERIES.length]
          const last = s.values.length - 1
          return (
            <g key={s.name}>
              {n > 1 && (
                <polygon points={`${x(0)},${y(0)} ${pts} ${x(last)},${y(0)}`} fill={`url(#${uid}-a${si})`} />
              )}
              <polyline
                fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round"
                className={colour.stroke} points={pts}
              />
              <circle cx={x(last)} cy={y(s.values[last])} r={3.5} className={colour.fill} />
              {n <= 45 && s.values.map((v, i) => (
                <circle key={i} cx={x(i)} cy={y(v)} r={5} className={`${colour.fill} opacity-0 hover:opacity-100`}>
                  <title>{`${s.name}, ${labels[i]}: ${v}`}</title>
                </circle>
              ))}
            </g>
          )
        })}
      </svg>
      <Legend items={series.map((s, i) => ({ name: s.name, idx: i }))} />
    </div>
  )
}

export function BarChart({ data, label }: { data: { label: string; value: number }[]; label: string }) {
  const uid = useId().replace(/:/g, "")
  const max = Math.max(0, ...data.map((d) => d.value))
  if (data.length === 0 || max === 0) return <Empty />
  const W = 600, H = 160, L = 28, B = 20, T = 6
  const slot = (W - L) / data.length
  const step = Math.ceil(data.length / 12)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
      <defs>
        <linearGradient id={`${uid}-bar`} x1="0" x2="0" y1="0" y2="1" className="text-accent">
          <stop offset="0%" stopColor="currentColor" stopOpacity={1} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0.45} />
        </linearGradient>
      </defs>
      <line x1={L} x2={W} y1={H - B} y2={H - B} className="stroke-line" />
      <line x1={L} x2={W} y1={T + 4} y2={T + 4} strokeDasharray="3 4" className="stroke-line" />
      <text x={L - 4} y={T + 8} textAnchor="end" className="fill-ink-muted text-[10px]">{max}</text>
      <text x={L - 4} y={H - B} textAnchor="end" className="fill-ink-muted text-[10px]">0</text>
      {data.map((d, i) => {
        const h = (d.value / max) * (H - B - T - 4)
        return (
          <g key={d.label + i}>
            <rect
              x={L + i * slot + slot * 0.15} y={H - B - h} width={slot * 0.7} height={h} rx={3}
              fill={`url(#${uid}-bar)`} className="transition-opacity hover:opacity-80"
            >
              <title>{`${d.label}: ${d.value}`}</title>
            </rect>
            {i % step === 0 && (
              <text x={L + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="fill-ink-muted text-[10px]">{d.label}</text>
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
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="relative h-32 w-32 shrink-0">
        <svg viewBox="0 0 100 100" role="img" aria-label={label} className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth="12" className="stroke-tint" />
          {parts.map((d, i) => {
            const len = (d.value / total) * c
            const el = (
              <circle key={d.label} cx="50" cy="50" r={r} fill="none" strokeWidth="12"
                className={SERIES[i % SERIES.length].stroke}
                strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}>
                <title>{`${d.label}: ${d.value} (${Math.round((d.value / total) * 100)}%)`}</title>
              </circle>
            )
            offset += len
            return el
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-[family-name:var(--font-admin-serif)] text-2xl tabular-nums text-ink">{total}</span>
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">total</span>
        </div>
      </div>
      <Legend items={parts.map((d, i) => ({ name: d.label, idx: i, value: `${d.value} (${Math.round((d.value / total) * 100)}%)` }))} />
    </div>
  )
}

export function HBars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(0, ...data.map((d) => d.value))
  if (data.length === 0 || max === 0) return <Empty />
  return (
    <ul className="space-y-3">
      {data.map((d) => (
        <li key={d.label} className="text-sm">
          <div className="flex justify-between gap-2">
            <span className="truncate text-ink-soft">{d.label}</span>
            <span className="font-medium tabular-nums text-ink">{d.value}</span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-tint" aria-hidden>
            <div
              className="h-2 rounded-full bg-linear-to-r from-accent/60 to-accent"
              style={{ width: `${(d.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
