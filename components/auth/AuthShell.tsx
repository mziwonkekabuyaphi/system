import type { ReactNode } from "react";
import "../../app/auth/theme.css";
import styles from "./AuthShell.module.css";

export function AuthShell({
  ticketNumber,
  tagline,
  heading,
  subheading,
  children,
}: {
  ticketNumber: string;
  tagline: string;
  heading: string;
  subheading: string;
  children: ReactNode;
}) {
  return (
    <div className="qless-auth-page">
      <aside className={styles.stub}>
        <span className={styles.brand}>QLess</span>
        <div className={styles.ticketBlock}>
          <span className={styles.ticketLabel}>Now serving</span>
          <span className={styles.ticketNumber}>{ticketNumber}</span>
          <p className={styles.tagline}>{tagline}</p>
        </div>
        <span className={styles.ticketLabel}>qless.systems</span>
      </aside>

      <section className={styles.formPanel}>
        <div className={styles.formInner}>
          <div className={styles.mobileBrand}>QLess</div>
          <h1 className={styles.heading}>{heading}</h1>
          <p className={styles.subheading}>{subheading}</p>
          {children}
        </div>
      </section>
    </div>
  );
}
