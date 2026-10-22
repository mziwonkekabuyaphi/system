import styles from "../docs.module.css";
import { DocsShell, PRICING_URL } from "../DocsShell";

export const metadata = {
  title: "Visits & billing — ZozoQueue docs",
  description:
    "How ZozoQueue counts a visit, what plans include, and how to change plan. Current prices are on the pricing page.",
};

// Prices are NOT written here: they come from the database, so this page links to the pricing page.
export default function BillingPage() {
  return (
    <DocsShell current="billing">
      <div className={styles.block}>
        <h1>Visits &amp; billing</h1>
        <p>
          A visit is one completed queue entry or one completed booking, whichever actually happened. A booking that
          is pulled into the queue and served counts once. Plans include a number of visits and staff, and extra
          visits or staff are charged at the rates on the <a href={PRICING_URL}>pricing page</a>. To change plan,
          request an upgrade from Billing in the dashboard.
        </p>
        <div className={styles.pagers}>
          <a className={styles.pager} href="/demo/docs/team">
            <span>Previous</span>
            ← Roles &amp; access
          </a>
          <a className={`${styles.pager} ${styles.pagerNext}`} href="/demo/docs/troubleshooting">
            <span>Next</span>
            Troubleshooting →
          </a>
        </div>
      </div>
    </DocsShell>
  );
}
