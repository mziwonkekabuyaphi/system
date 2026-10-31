// app/display/[slug]/shisha/HookahIcon.tsx
//
// The hookah drawing shown inside the ring of a FREE device, on both the Board
// and the Lounge view (it replaces the old plain spearhead shape).
//
// It is one drawing in the current text colour: the parent decides the colour
// (Board: the state colour, Lounge: the accent) by setting `color` on the
// wrapper, so it follows the theme and the shop's own colours automatically.
//
// The two soft smoke wisps and the bubbles move very gently. The motion is
// switched off for people who prefer reduced motion. Include `hookahCss` once
// per view, inside its `<style jsx global>` block (the SVG parts are not
// scoped to the view, so the animation classes have to be global).

export const hookahCss = `
  @keyframes hk-drift {
    0% { transform: translateY(2px); opacity: 0; }
    30% { opacity: 0.75; }
    100% { transform: translateY(-3px); opacity: 0; }
  }
  @keyframes hk-bub {
    0%, 100% { transform: translateY(0); opacity: 0.7; }
    50% { transform: translateY(-2.5px); opacity: 0.35; }
  }
  .hk-smoke { animation: hk-drift 3.2s ease-in-out infinite; }
  .hk-smoke.b { animation-delay: 1.4s; }
  .hk-bub { animation: hk-bub 2.4s ease-in-out infinite; }
  .hk-bub.b { animation-delay: 0.8s; }
  @media (prefers-reduced-motion: reduce) {
    .hk-smoke, .hk-bub { animation: none; }
    .hk-smoke { opacity: 0.5; }
  }
`

export function HookahIcon() {
  return (
    <svg
      viewBox="0 0 64 96"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* smoke */}
      <path className="hk-smoke" d="M29 11c-4-3 3-5-1-9" strokeWidth={2.2} />
      <path className="hk-smoke b" d="M36 12c-4-3 3-5-1-9" strokeWidth={2.2} />

      {/* clay bowl and the plate under it */}
      <path d="M21 17h22l-3.5 13h-15z" fill="currentColor" stroke="none" />
      <ellipse cx="32" cy="17" rx="11" ry="2.6" fill="currentColor" stroke="none" />
      <ellipse cx="32" cy="33" rx="16" ry="3.2" fill="currentColor" stroke="none" />

      {/* stem with its collar, and the hose coming off the side */}
      <rect x="29" y="35" width="6" height="22" rx="2" fill="currentColor" stroke="none" />
      <rect x="26" y="44" width="12" height="3.4" rx="1.7" fill="currentColor" stroke="none" />
      <path d="M40 51C58 46 62 66 57 78" />
      <path d="M57 78l.5 7" strokeWidth={4.5} />

      {/* glass base with the water and a few bubbles */}
      <path d="M26 58h12c0 7 14 12 14 26 0 7-5 10-10 10H22c-5 0-10-3-10-10 0-14 14-19 14-26z" />
      <path
        d="M13.2 82c6-3 12 3 18.8 0s12.8-3 18.8 0c-.9 6.5-5 10.5-9.8 10.5H23c-4.8 0-8.9-4-9.8-10.5z"
        fill="currentColor"
        fillOpacity={0.35}
        stroke="none"
      />
      <circle className="hk-bub" cx="26" cy="87" r="1.6" fill="currentColor" stroke="none" />
      <circle className="hk-bub b" cx="36" cy="85" r="1.2" fill="currentColor" stroke="none" />
      <circle className="hk-bub" cx="32" cy="89.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}
