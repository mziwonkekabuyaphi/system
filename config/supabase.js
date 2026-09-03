// config/supabase.js — QLess Systems V2
//
// IMPORTANT: this points at the NEW QLess Supabase project (muelggaqfjumjjdqtnaq).
// The old Rands project (odpugxrihfspaucsdqjj) must never be referenced from V2 code.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://muelggaqfjumjjdqtnaq.supabase.co';

// Publishable/anon key — safe to ship to the browser. RLS is the real security boundary.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im11ZWxnZ2FxZmp1bWpqZHF0bmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNzk1MjUsImV4cCI6MjEwMzk1NTUyNX0.TEJCSmvSgGrTFfT63QNIWgbjM6smsFXdjFYuVAkZOsw';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    experimental: {
      passkey: true,
    },
  },
});

window.supabase = supabase;
