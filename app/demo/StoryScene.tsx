// app/demo/StoryScene.tsx
//
// Landing-page section between "The problem" and "Who it's built for": a cartoon of one shop
// where everyone ends up in the same line. Pure SVG, no client code, no images to load.
// The numbered badges on the picture (1 WhatsApp, 2 kiosk, 3 TV and queue) match the three
// points beside it. Shop name, ticket numbers and customers are made up; edit them below.

import styles from "./demo.module.css"
import s from "./storyScene.module.css"

const NAVY = "#14325c"
const DEEP = "#0b1c36"
const AMBER = "#f5a524"
const INK = "#1c2430"
const FONT = "var(--qless-font-body), -apple-system, BlinkMacSystemFont, sans-serif"

const AWNING = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: 140 + i * 50, fill: i % 2 === 0 ? AMBER : "#ffffff" }))

const QUEUE = [
  { x: 170, skin: "#5c3a21", body: AMBER, hair: DEEP, label: "B019" },
  { x: 260, skin: "#c68642", body: "#2f80c8", hair: INK, label: "B018" },
  { x: 350, skin: "#e0ac69", body: "#6b5bd6", hair: "#5c3a21", label: "B017" },
  { x: 440, skin: "#8d5524", body: "#e8523f", hair: INK, label: "B016" },
]

const POINTS = [
  { title: "Book from the couch", text: "Customers message your WhatsApp number and get a time confirmed in seconds, at any hour." },
  { title: "Check in at the door", text: "Walk-ins tap the kiosk and get a ticket with their place in line and an estimated wait." },
  { title: "One live line", text: "Bookings and the walk-in queue sit together on your dashboard and the waiting-room TV, so nobody gets missed." },
]

function Face({ cx, cy, e = 8, dy = 3 }: { cx: number; cy: number; e?: number; dy?: number }) {
  return (
    <>
      <circle cx={cx - e} cy={cy + dy} r="2.4" fill={INK} />
      <circle cx={cx + e} cy={cy + dy} r="2.4" fill={INK} />
      <path d={`M${cx - e} ${cy + dy + 9} Q${cx} ${cy + dy + 16} ${cx + e} ${cy + dy + 9}`} fill="none" stroke={INK} strokeWidth="2" strokeLinecap="round" />
    </>
  )
}

function Hair({ cx, cy, r, color }: { cx: number; cy: number; r: number; color: string }) {
  return <path d={`M${cx - r} ${cy - 3} A${r} ${r} 0 0 1 ${cx + r} ${cy - 3} Z`} fill={color} />
}

function Tick({ cx, cy }: { cx: number; cy: number }) {
  return (
    <>
      <circle cx={cx} cy={cy} r="8" fill="#22a35a" />
      <path d={`M${cx - 4} ${cy} l3 3 l5 -6`} fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  )
}

function Badge({ cx, cy, n }: { cx: number; cy: number; n: number }) {
  return (
    <>
      <circle cx={cx} cy={cy} r="14" fill={AMBER} stroke={DEEP} strokeWidth="3" />
      <text x={cx} y={cy + 5.5} textAnchor="middle" fill={DEEP} fontSize="16" fontWeight="800">{n}</text>
    </>
  )
}

function Queuer({ x, skin, body, hair, label }: (typeof QUEUE)[number]) {
  return (
    <g>
      <rect x={x - 16} y="700" width="18" height="40" rx="5" fill={DEEP} />
      <rect x={x + 8} y="700" width="18" height="40" rx="5" fill={DEEP} />
      <rect x={x - 26} y="640" width="52" height="66" rx="20" fill={body} />
      <circle cx={x} cy="616" r="22" fill={skin} />
      <Hair cx={x} cy={616} r={22} color={hair} />
      <Face cx={x} cy={616} />
      <rect x={x - 29} y="556" width="58" height="24" rx="4" fill="#f4ecdc" />
      <text x={x} y="573" textAnchor="middle" fill={DEEP} fontSize="13" fontWeight="700">{label}</text>
    </g>
  )
}

export function StoryScene() {
  return (
    <section>
      <div className={styles.wrapWide}>
        <p className={styles.sectionLabel}>One shop, one line</p>
        <div className={styles.sectionHead}>
          <h2>However they arrive, everyone ends up in the same line.</h2>
        </div>

        <div className={s.story}>
          <figure className={s.art}>
            <svg viewBox="0 0 680 780" role="img" aria-labelledby="story-title story-desc" style={{ fontFamily: FONT }}>
              <title id="story-title">A shop where WhatsApp bookings, kiosk check-ins and walk-ins share one queue</title>
              <desc id="story-desc">
                A cartoon barbershop with a striped awning and a TV showing the number being served. A customer books on WhatsApp
                on their phone, another taps the check-in kiosk, and four customers wait in line holding tickets. A card above
                shows today’s bookings.
              </desc>

              <rect width="680" height="780" rx="16" fill={NAVY} />
              {[[90, 28], [250, 24], [420, 30], [560, 26], [640, 40]].map(([x, y]) => (
                <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="#ffffff" opacity="0.5" />
              ))}

              {/* WhatsApp chat card */}
              <rect x="40" y="56" width="300" height="130" rx="14" fill="#efeae2" />
              <path d="M40 86 V70 a14 14 0 0 1 14-14 H326 a14 14 0 0 1 14 14 V86 Z" fill="#075e54" />
              <circle cx="58" cy="71" r="9" fill={AMBER} />
              <text x="74" y="76" fill="#ffffff" fontSize="13" fontWeight="700">Mzansi Cuts</text>
              <rect x="140" y="96" width="186" height="28" rx="10" fill="#d9fdd3" />
              <text x="152" y="115" fill="#111b21" fontSize="13">Fade today at 14:30?</text>
              <rect x="54" y="132" width="206" height="40" rx="10" fill="#ffffff" />
              <text x="66" y="157" fill="#111b21" fontSize="13">Booked! See you at 14:30</text>
              <Tick cx={296} cy={152} />

              {/* Today's bookings card */}
              <rect x="372" y="56" width="268" height="130" rx="14" fill="#ffffff" />
              <path d="M372 90 V70 a14 14 0 0 1 14-14 H626 a14 14 0 0 1 14 14 V90 Z" fill={AMBER} />
              <text x="388" y="78" fill={DEEP} fontSize="13" fontWeight="700">Today’s bookings</text>
              <rect x="386" y="100" width="50" height="22" rx="11" fill="#e6eeff" />
              <text x="411" y="115" textAnchor="middle" fill="#1d4ed8" fontSize="12" fontWeight="700">14:30</text>
              <text x="446" y="115" fill={INK} fontSize="13">Naledi · Fade</text>
              <Tick cx={620} cy={111} />
              <rect x="386" y="128" width="50" height="22" rx="11" fill="#fdf0d5" />
              <text x="411" y="143" textAnchor="middle" fill="#8a4b08" fontSize="12" fontWeight="700">15:00</text>
              <text x="446" y="143" fill={INK} fontSize="13">Jaco · Beard trim</text>
              <Tick cx={620} cy={139} />
              <rect x="386" y="156" width="50" height="22" rx="11" fill="#ffffff" stroke="#b9b3a2" strokeDasharray="3 3" />
              <text x="411" y="171" textAnchor="middle" fill="#7a7466" fontSize="12" fontWeight="700">15:30</text>
              <text x="446" y="171" fill="#7a7466" fontSize="13">Open slot</text>

              {/* Street */}
              <rect y="640" width="680" height="140" fill={DEEP} />
              <rect y="640" width="680" height="14" fill="#2a5a99" />

              {/* Shop */}
              <rect x="210" y="214" width="260" height="46" rx="8" fill={DEEP} stroke={AMBER} strokeWidth="3" />
              <text x="340" y="245" textAnchor="middle" fill={AMBER} fontSize="22" fontWeight="700">Mzansi Cuts</text>
              <rect x="150" y="288" width="380" height="352" fill="#faf7f0" />
              <rect x="150" y="620" width="380" height="20" fill="#e3ded2" />
              <rect x="140" y="262" width="400" height="26" rx="4" fill={DEEP} />
              {AWNING.map((a) => (
                <g key={a.x} fill={a.fill}>
                  <rect x={a.x} y="300" width="50" height="40" />
                  <circle cx={a.x + 25} cy="340" r="25" />
                </g>
              ))}

              {/* Window with the queue TV */}
              <rect x="175" y="385" width="170" height="140" rx="6" fill="#cfe6f5" stroke={DEEP} strokeWidth="3" />
              <path d="M190 515 L230 395" stroke="#ffffff" strokeWidth="6" opacity="0.5" />
              <rect x="195" y="405" width="130" height="76" rx="4" fill={DEEP} />
              <text x="260" y="428" textAnchor="middle" fill={AMBER} fontSize="11">Now serving</text>
              <text x="260" y="466" textAnchor="middle" fill="#ffffff" fontSize="28" fontWeight="700">B015</text>

              {/* Door */}
              <rect x="385" y="395" width="100" height="245" rx="6" fill="#1f8a70" stroke={DEEP} strokeWidth="3" />
              <rect x="403" y="415" width="64" height="70" rx="4" fill="#cfe6f5" />
              <rect x="415" y="500" width="40" height="22" rx="3" fill={AMBER} />
              <text x="435" y="516" textAnchor="middle" fill={DEEP} fontSize="12" fontWeight="700">Open</text>
              <circle cx="472" cy="540" r="6" fill={AMBER} />

              {/* Kiosk */}
              <rect x="602" y="526" width="14" height="106" fill="#2b3038" />
              <rect x="583" y="632" width="52" height="10" rx="4" fill="#2b3038" />
              <rect x="566" y="450" width="86" height="76" rx="10" fill="#16191f" />
              <rect x="573" y="458" width="72" height="60" rx="5" fill="#faf7f0" />
              <circle cx="609" cy="478" r="8" fill={NAVY} />
              <rect x="587" y="494" width="44" height="16" rx="8" fill={AMBER} />

              {/* Customer booking on WhatsApp */}
              <circle cx="80" cy="470" r="24" fill="#c68642" />
              <Hair cx={80} cy={470} r={24} color={INK} />
              <Face cx={80} cy={470} dy={4} />
              <rect x="58" y="598" width="18" height="44" rx="5" fill={DEEP} />
              <rect x="84" y="598" width="18" height="44" rx="5" fill={DEEP} />
              <rect x="50" y="498" width="60" height="110" rx="24" fill="#1f8a70" />
              <path d="M104 528 L126 498" stroke="#1f8a70" strokeWidth="12" strokeLinecap="round" />
              <rect x="122" y="452" width="34" height="58" rx="6" fill="#16191f" />
              <rect x="125" y="457" width="28" height="44" rx="3" fill="#efeae2" />
              <rect x="128" y="462" width="18" height="8" rx="3" fill="#d9fdd3" />
              <rect x="132" y="476" width="18" height="8" rx="3" fill="#ffffff" />
              <circle cx="128" cy="500" r="7" fill="#c68642" />

              {/* Customer at the kiosk */}
              <circle cx="525" cy="515" r="18" fill="#e0ac69" />
              <Hair cx={525} cy={515} r={18} color="#5c3a21" />
              <Face cx={525} cy={515} e={6} />
              <rect x="508" y="620" width="14" height="22" rx="4" fill={DEEP} />
              <rect x="528" y="620" width="14" height="22" rx="4" fill={DEEP} />
              <rect x="503" y="535" width="44" height="95" rx="18" fill="#e8523f" />
              <path d="M543 556 L566 508" stroke="#e8523f" strokeWidth="12" strokeLinecap="round" />
              <circle cx="568" cy="504" r="6" fill="#e0ac69" />

              {/* The queue */}
              {QUEUE.map((q) => (
                <Queuer key={q.label} {...q} />
              ))}

              {/* Numbered badges, matching the points beside the picture */}
              <Badge cx={36} cy={430} n={1} />
              <Badge cx={662} cy={430} n={2} />
              <Badge cx={359} cy={396} n={3} />
            </svg>
          </figure>

          <ol className={s.points}>
            {POINTS.map((p, i) => (
              <li key={p.title} className={s.point}>
                <span className={s.num} aria-hidden="true">{i + 1}</span>
                <div>
                  <h3>{p.title}</h3>
                  <p>{p.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}
