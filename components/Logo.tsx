type LogoProps = {
  size?: number;
  className?: string;
};

/**
 * The ZozoQueue Q-mark: a ring (the queue, held in a circle) with an
 * amber tail bursting out the back (forward motion — your place is moving).
 *
 * The ring uses currentColor, so it reads correctly on both the light
 * nav bar (inherits --qless-ink) and the dark hero stub (inherits
 * --qless-paper) without needing separate light/dark variants.
 */
export function Logo({ size = 24, className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="46" cy="50" r="34" fill="none" stroke="currentColor" strokeWidth="15" />
      <path d="M58,68 L86,92 L94,80 L70,58 Z" fill="#F5A623" />
    </svg>
  );
}
