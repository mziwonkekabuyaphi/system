// app/demo/KioskPrinter.tsx
//
// "The paper ticket": a cartoon of a floor-standing kiosk with a receipt printer under the
// screen, a queue ticket coming out of it and a booking reference slip beside it. Pure SVG,
// no client code, no images. It reuses the layout from storyScene.module.css (picture on one
// side, three numbered points on the other). Shop name, ticket number and reference are made
// up; edit them below.
//
// It renders a plain <div> (not a <section>) so it can sit inside an existing section, e.g.
// under the kiosk demo on the live page.

import styles from "./demo.module.css"
import s from "./storyScene.module.css"

const NAVY = "#14325c"
const DEEP = "#0b1c36"
const AMBER = "#f5a524"
const INK = "#1c2430"
const BODY = "#2b3038"
const FONT = "var(--qless-font-body), -apple-system, BlinkMacSystemFont, sans-serif"
const MONO = "var(--qless-font-mono), ui-monospace, SFMono-Regular, Menlo, monospace"

const POINTS = [
  {
    title: "A queue ticket for walk-ins",
    text: "Customers who join the queue take a printed ticket with their number, their place in line and an estimated wait.",
  },
  {
    title: "A reference slip for bookings",
    text: "Customers who book a time get their reference, day and time on paper, so they can show it at the counter.",
  },
  {
    title: "The same number on every screen",
    text: "The number on the paper is the one on your dashboard and the waiting-room TV, so staff call it out and nobody is missed.",
  },
]

function Badge({ cx, cy, n }: { cx: number; cy: number; n: number }) {
  return (
    <>
      <circle cx={cx} cy={cy} r="15" fill={AMBER} stroke={DEEP} strokeWidth="3" />
      <text x={cx} y={cy + 6} textAnchor="middle" fill={DEEP} fontSize="17" fontWeight="800">
        {n}
      </text>
    </>
  )
}

export function KioskPrinter() {
  return (
    <div>
      <p className={styles.sectionLabel}>The paper ticket</p>
      <div className={styles.sectionHead}>
        <h2>Walk-ins and bookings both leave with a printed slip.</h2>
      </div>
      <p className={styles.sectionIntro}>
        The kiosk prints on a thermal receipt printer, the same kind used at a till. Queue customers get a ticket and booking
        customers get a reference, so they have something in their hand when they sit down.
      </p>

      <div className={s.story}>
        <figure className={s.art}>
          <svg viewBox="0 0 680 760" role="img" aria-labelledby="kp-title kp-desc" style={{ fontFamily: FONT }}>
            <title id="kp-title">A self-serve kiosk with a receipt printer printing a queue ticket and a booking reference</title>
            <desc id="kp-desc">
              A floor-standing kiosk with a tablet screen showing two buttons, Book a time and Join the queue. A receipt printer
              under the screen has pushed out a queue ticket with the number B015, position 3 and about 20 minutes. Beside the
              kiosk is a booking reference slip with the reference ZQ-4821 for a fade today at 14:30.
            </desc>

            <rect width="680" height="760" rx="16" fill={NAVY} />
            {[[80, 40], [230, 28], [400, 44], [560, 30], [640, 60]].map(([x, y]) => (
              <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="#ffffff" opacity="0.5" />
            ))}

            {/* Floor */}
            <rect y="690" width="680" height="70" fill={DEEP} />
            <rect y="690" width="680" height="10" fill="#2a5a99" />

            {/* Kiosk cabinet and base plate */}
            <rect x="160" y="672" width="280" height="20" rx="8" fill="#1d2127" />
            <rect x="180" y="70" width="240" height="610" rx="26" fill={BODY} />
            <rect x="180" y="70" width="240" height="610" rx="26" fill="none" stroke="#3a404a" strokeWidth="3" />

            {/* Tablet screen */}
            <rect x="198" y="90" width="204" height="262" rx="14" fill="#16191f" />
            <rect x="208" y="102" width="184" height="238" rx="8" fill="#faf7f0" />
            <circle cx="300" cy="146" r="22" fill={NAVY} />
            <text x="300" y="154" textAnchor="middle" fill={AMBER} fontSize="22" fontWeight="800">M</text>
            <text x="300" y="196" textAnchor="middle" fill={INK} fontSize="17" fontWeight="800">Mzansi Cuts</text>
            <rect x="220" y="222" width="76" height="80" rx="10" fill={NAVY} />
            <text x="258" y="258" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="800">Book</text>
            <text x="258" y="276" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="800">a time</text>
            <rect x="304" y="222" width="76" height="80" rx="10" fill={AMBER} />
            <text x="342" y="258" textAnchor="middle" fill={DEEP} fontSize="14" fontWeight="800">Join the</text>
            <text x="342" y="276" textAnchor="middle" fill={DEEP} fontSize="14" fontWeight="800">queue</text>
            <circle cx="300" cy="327" r="4" fill="#3a404a" />

            {/* Printer unit */}
            <rect x="198" y="378" width="204" height="118" rx="14" fill="#3a404a" />
            <rect x="198" y="378" width="204" height="118" rx="14" fill="none" stroke="#4b525e" strokeWidth="2" />
            <text x="216" y="402" fill="#b9c0cc" fontSize="13" fontWeight="700" letterSpacing="1.5">TICKETS</text>
            <circle cx="382" cy="396" r="5" fill="#22c55e" />
            <rect x="222" y="440" width="156" height="14" rx="7" fill="#0b0d11" />

            {/* Queue ticket coming out of the printer */}
            <g>
              <rect x="236" y="446" width="128" height="214" fill="#ffffff" stroke="#d9d3c4" />
              <path d="M236 660 l8 8 l8 -8 l8 8 l8 -8 l8 8 l8 -8 l8 8 l8 -8 l8 8 l8 -8 l8 8 l8 -8 V660 Z" fill="#ffffff" stroke="#d9d3c4" />
              <text x="300" y="474" textAnchor="middle" fill="#7a7466" fontSize="12" fontWeight="700" letterSpacing="1.2">QUEUE TICKET</text>
              <text x="300" y="520" textAnchor="middle" fill={DEEP} fontSize="46" fontWeight="800" style={{ fontFamily: MONO }}>B015</text>
              <line x1="248" y1="540" x2="352" y2="540" stroke="#b9b3a2" strokeDasharray="4 4" />
              <text x="300" y="566" textAnchor="middle" fill={INK} fontSize="15" fontWeight="700">Naledi P.</text>
              <text x="300" y="588" textAnchor="middle" fill="#4a5260" fontSize="14">Fade</text>
              <text x="300" y="612" textAnchor="middle" fill="#4a5260" fontSize="14">Position 3</text>
              <text x="300" y="634" textAnchor="middle" fill="#4a5260" fontSize="14">About 20 min</text>
            </g>

            {/* Booking reference slip */}
            <g transform="rotate(5 560 400)">
              <rect x="490" y="290" width="150" height="206" fill="#ffffff" stroke="#d9d3c4" />
              <path d="M490 496 l9 8 l9 -8 l9 8 l9 -8 l9 8 l9 -8 l9 8 l9 -8 l9 8 l9 -8 l9 8 l9 -8 l9 8 l9 -8 l9 8 V496 Z" fill="#ffffff" stroke="#d9d3c4" />
              <text x="565" y="318" textAnchor="middle" fill="#7a7466" fontSize="12" fontWeight="700" letterSpacing="1.2">BOOKING</text>
              <text x="565" y="338" textAnchor="middle" fill="#7a7466" fontSize="12" fontWeight="700" letterSpacing="1.2">REFERENCE</text>
              <text x="565" y="378" textAnchor="middle" fill={DEEP} fontSize="27" fontWeight="800" style={{ fontFamily: MONO }}>ZQ-4821</text>
              <line x1="504" y1="396" x2="626" y2="396" stroke="#b9b3a2" strokeDasharray="4 4" />
              <text x="565" y="422" textAnchor="middle" fill={INK} fontSize="15" fontWeight="700">Naledi P.</text>
              <text x="565" y="444" textAnchor="middle" fill="#4a5260" fontSize="14">Fade with Thabo</text>
              <text x="565" y="466" textAnchor="middle" fill="#4a5260" fontSize="14">Today at 14:30</text>
            </g>

            {/* Numbered badges, matching the points beside the picture */}
            <Badge cx={236} cy={446} n={1} />
            <Badge cx={494} cy={292} n={2} />
            <Badge cx={198} cy={92} n={3} />
          </svg>
          <figcaption style={{ marginTop: 10, fontSize: 13, color: "var(--qless-ink-soft, #4a5260)" }}>
            An illustration. Your kiosk hardware may look different.
          </figcaption>
        </figure>

        <ol className={s.points}>
          {POINTS.map((p, i) => (
            <li key={p.title} className={s.point}>
              <span className={s.num} aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h3>{p.title}</h3>
                <p>{p.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
