"use client";

import { useState, type ChangeEvent } from "react";
import styles from "./AuthForm.module.css";

/**
 * Password input with an eye button that shows/hides what's typed.
 * Used by LoginForm and SignupForm so both behave the same. The button is
 * type="button" so it never submits the form, and the field keeps focus
 * handling/autocomplete exactly as a normal password input.
 */
export function PasswordInput({
  id,
  name,
  value,
  onChange,
  autoComplete,
  minLength,
  invalid,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  invalid?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={styles.passwordWrap}>
      <input
        id={id}
        name={name}
        className={styles.passwordInput}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        required
        minLength={minLength}
        value={value}
        onChange={onChange}
        aria-invalid={invalid}
      />
      <button
        type="button"
        className={styles.reveal}
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-label={visible ? "Hide password" : "Show password"}
        title={visible ? "Hide password" : "Show password"}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4" />
      <path d="M6.6 6.7C3.9 8.5 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3 3l18 18" />
    </svg>
  );
}
