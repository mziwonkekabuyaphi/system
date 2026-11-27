import type { ReactNode } from "react";
import base from "../../demo.module.css"; // FAQ styles
import styles from "../docs.module.css";
import { Table } from "../Table";
import { DocsShell } from "../DocsShell";

export const metadata = {
  title: "Your own AI — ZozoQueue docs",
  description:
    "Make your WhatsApp assistant smarter with your own Claude or OpenAI key: add the key, switch the AI on, set a monthly limit and see what it uses.",
};

// Checked against Settings > AI in the product (the AI card sits in the WhatsApp settings).

const PROVIDERS = [
  ["Claude (Anthropic)", "Create a key in your Anthropic account and paste it in."],
  ["OpenAI", "Create a key in your OpenAI account and paste it in."],
];

const DOES = [
  ["Understanding messages", "Works out what the customer wants from a normal sentence."],
  ["Answering questions", "Replies to questions such as opening hours."],
  ["Reading booking requests", "Turns “haircut Saturday morning” into a booking request."],
];

const STEPS = [
  ["Open the AI settings", "In Settings, open the WhatsApp messages page. The AI card is there."],
  ["Choose your provider and model", "Pick Claude (Anthropic) or OpenAI, then the model you want it to use."],
  ["Paste your API key", "The key is saved encrypted and the full key is never shown again. Only its last 4 characters appear."],
  ["Switch the AI on", "Use the Enable AI switch. With it off, customers get the standard menu."],
  ["Set a monthly limit", "Enter a limit in rand and a warning percentage. Leave the limit empty for no limit."],
];

const BLOCKED = [
  ["AI is switched off", "Customers get the standard menu."],
  ["No key saved", "Add your API key to turn the AI on."],
  ["Your provider rejected the key", "The AI pauses. Replace the key to turn it back on."],
  ["Monthly limit reached", "The AI pauses until next month, or until you raise the limit."],
];

const QA = [
  ["Do I need my own AI account?", "To use the AI features, yes: you add a key from Claude (Anthropic) or OpenAI and pay that provider directly for what it uses."],
  ["What happens if the AI can’t answer?", "Customers get the standard menu instead, and any conversation can be handed to a person with one tap."],
  ["Can I see what it costs?", "Yes. The AI card shows tokens used, an estimated cost and the number of AI requests this month, and what the AI was used for over the last 30 days. The estimate uses your provider’s list prices, and your provider’s invoice is the final word."],
  ["Can a busy month surprise me?", "Not if you set a monthly limit. The AI pauses by itself when the estimated cost reaches it."],
  ["Is my key safe?", "It is saved encrypted on our servers, and the browser only ever receives its last 4 characters."],
];

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className={base.faqItem}>
      <summary>
        {q}
        <svg className={base.faqIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </summary>
      <p className={base.faqAnswer}>{children}</p>
    </details>
  );
}

export default function AiPage() {
  return (
    <DocsShell current="ai">
      <div className={styles.block}>
        <h1>Your own AI</h1>
        <p>
          Included in the Business plan. Make your WhatsApp assistant smarter by adding your own AI account. Customers can write the way they talk,
          and you stay in control of the cost with a monthly limit.
        </p>
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          <li><a href="#providers">Providers</a></li>
          <li><a href="#does">What the AI does</a></li>
          <li><a href="#steps">Setting it up</a></li>
          <li><a href="#paused">When the AI is paused</a></li>
          <li><a href="#questions">Common questions</a></li>
        </ul>
      </nav>

      <div id="providers" className={`${styles.block} ${styles.detail}`}>
        <h2>Providers</h2>
        <Table head={["Provider", "How to get a key"]} rows={PROVIDERS} />
      </div>

      <div id="does" className={`${styles.block} ${styles.detail}`}>
        <h2>What the AI does</h2>
        <Table head={["Job", "What it means"]} rows={DOES} />
      </div>

      <div id="steps" className={styles.block}>
        <h2>Setting it up</h2>
        <ol className={styles.steps}>
          {STEPS.map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </div>

      <div id="paused" className={`${styles.block} ${styles.detail}`}>
        <h2>When the AI is paused</h2>
        <p>The card always tells you why. Meanwhile your customers are never left without an answer.</p>
        <Table head={["State", "What happens"]} rows={BLOCKED} />
      </div>

      <div id="questions" className={styles.block}>
        <h2>Common questions</h2>
        <div className={base.faqList}>
          {QA.map(([q, a]) => (
            <Faq key={q} q={q}>{a}</Faq>
          ))}
        </div>
      </div>
    </DocsShell>
  );
}
