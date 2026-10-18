// app/demo/industries.ts
//
// Example shops for the landing-page demos. Everything here is made up. Each industry
// carries its own wording and brand colours on purpose: on the real kiosk every shop
// sets its own button text and colours (Settings > Kiosk), so a clinic shouldn't have to
// say "Book a time" and a tyre centre doesn't want to say "Join the queue".
// The default wording matches DEFAULT_* in app/kiosk/[slug]/page.tsx.

export type IndustryId = "barber" | "beauty" | "clinic" | "workshop" | "vet"

/** What the WhatsApp demo says for this kind of shop. Wording itself lives in ChatDemo.tsx. */
export type ChatData = {
  emoji: string
  /** First name of the example customer. */
  name: string
  /** The fully-booked day used in the "Day is full" chat. */
  day: string
  /** Exactly three. The first is the one the customer books. */
  menu: [Menu, Menu, Menu]
  /** Exactly four. The customer takes the third. */
  times: [string, string, string, string]
  ref: string
  ticket: string
  ahead: number
  waitMin: number
}
type Menu = { name: string; price: number; mins: number }

export type Industry = {
  id: IndustryId
  /** Short label for the picker. */
  label: string
  shop: string
  initial: string
  /** Kiosk wording, as a shop would set it. */
  choiceTitle: string
  bookTitle: string
  bookSub: string
  queueTitle: string
  queueSub: string
  serviceTitle: string
  /** Exactly four, so the service grid always lines up. */
  services: [string, string, string, string]
  picked: string
  customer: string
  phone: string
  ticket: string
  position: number
  waitMin: number
  chat: ChatData
  /** Brand colours. Omit to use the site's own navy and amber. */
  brand?: { main: string; mainDeep: string; accent: string; accentDeep: string; onAccent: string }
}

export const INDUSTRIES: Industry[] = [
  {
    id: "barber",
    label: "Barbershop",
    shop: "Mzansi Cuts Barbershop",
    initial: "T",
    choiceTitle: "How can we help you today?",
    bookTitle: "Book a time",
    bookSub: "Pick a date and time that works for you",
    queueTitle: "Join the queue",
    queueSub: "Walk in now and we’ll call you",
    serviceTitle: "What are you here for?",
    services: ["Haircut", "Beard trim", "Haircut + beard", "Kids cut"],
    picked: "Beard trim",
    customer: "Aiden K.",
    phone: "082 123 4567",
    ticket: "A016",
    position: 3,
    waitMin: 24,
    chat: {
      emoji: "💈",
      name: "Sipho",
      day: "Saturday",
      menu: [
        { name: "Haircut", price: 120, mins: 30 },
        { name: "Beard trim", price: 60, mins: 20 },
        { name: "Haircut + beard", price: 160, mins: 45 },
      ],
      times: ["09:00", "09:30", "10:30", "14:00"],
      ref: "K7Q2XM",
      ticket: "A014",
      ahead: 3,
      waitMin: 25,
    },
  },
  {
    id: "beauty",
    label: "Beauty & nails",
    shop: "Cape Town’s Beauty Studio",
    initial: "L",
    choiceTitle: "Welcome! What would you like to do?",
    bookTitle: "Book a treatment",
    bookSub: "Choose a day and time",
    queueTitle: "I’m a walk-in",
    queueSub: "Take a ticket and we’ll call you",
    serviceTitle: "Which treatment would you like?",
    services: ["Gel set", "Brow tint", "Manicure", "Lashes"],
    picked: "Gel set",
    customer: "Naledi P.",
    phone: "071 555 0142",
    ticket: "A012",
    position: 2,
    waitMin: 35,
    chat: {
      emoji: "💅",
      name: "Sisipho",
      day: "Saturday",
      menu: [
        { name: "Gel set", price: 280, mins: 60 },
        { name: "Brow tint", price: 90, mins: 20 },
        { name: "Manicure", price: 150, mins: 40 },
      ],
      times: ["09:00", "11:00", "13:30", "15:00"],
      ref: "P4N8RC",
      ticket: "A006",
      ahead: 2,
      waitMin: 40,
    },
    brand: { main: "#7a2e62", mainDeep: "#571f45", accent: "#f2b6cf", accentDeep: "#e58fb3", onAccent: "#3e1630" },
  },
  {
    id: "clinic",
    label: "Clinic",
    shop: "Ubuntu Family Clinic",
    initial: "U",
    choiceTitle: "How can we help you today?",
    bookTitle: "Book an appointment",
    bookSub: "Choose a day and time",
    queueTitle: "I’m a walk-in patient",
    queueSub: "Sign in and we’ll call your name",
    serviceTitle: "What is your visit for?",
    services: ["Consultation", "Blood pressure", "Vaccination", "Repeat script"],
    picked: "Vaccination",
    customer: "Mzonke R.",
    phone: "083 555 0188",
    ticket: "A031",
    position: 4,
    waitMin: 40,
    chat: {
      emoji: "🩺",
      name: "Mandla",
      day: "Friday",
      menu: [
        { name: "Consultation", price: 450, mins: 20 },
        { name: "Blood pressure check", price: 90, mins: 10 },
        { name: "Vaccination", price: 220, mins: 15 },
      ],
      times: ["08:30", "09:15", "10:45", "14:30"],
      ref: "T9W3HD",
      ticket: "A028",
      ahead: 4,
      waitMin: 45,
    },
    brand: { main: "#1f6f78", mainDeep: "#14505a", accent: "#bfe6e2", accentDeep: "#8fd0ca", onAccent: "#0e3a40" },
  },
  {
    id: "workshop",
    label: "Auto workshop",
    shop: "Mthembu Tyre & Auto",
    initial: "M",
    choiceTitle: "Dropping in or booked in?",
    bookTitle: "Book a service",
    bookSub: "Pick a day and drop-off time",
    queueTitle: "Drop in now",
    queueSub: "We’ll message you when we’re ready",
    serviceTitle: "What does your car need?",
    services: ["Tyre repair", "Wheel alignment", "Full service", "Battery check"],
    picked: "Tyre repair",
    customer: "Jaco V.",
    phone: "082 555 0173",
    ticket: "A009",
    position: 2,
    waitMin: 30,
    chat: {
      emoji: "🔧",
      name: "Jaco",
      day: "Friday",
      menu: [
        { name: "Tyre repair", price: 150, mins: 30 },
        { name: "Wheel alignment", price: 320, mins: 45 },
        { name: "Full service", price: 1850, mins: 120 },
      ],
      times: ["07:30", "08:30", "10:00", "13:00"],
      ref: "M2X7BL",
      ticket: "A011",
      ahead: 2,
      waitMin: 35,
    },
    brand: { main: "#2f3a45", mainDeep: "#1d252d", accent: "#f26b21", accentDeep: "#c94f10", onAccent: "#1d252d" },
  },
  {
    id: "vet",
    label: "Vet",
    shop: "Hillcrest Vet Clinic",
    initial: "H",
    choiceTitle: "Welcome! How can we help?",
    bookTitle: "Book a visit",
    bookSub: "Pick a day and time",
    queueTitle: "Same-day, no booking",
    queueSub: "Join the queue and we’ll call you in",
    serviceTitle: "What is your pet here for?",
    services: ["Check-up", "Vaccination", "Dental clean", "Sick pet"],
    picked: "Check-up",
    customer: "Riaan B.",
    phone: "084 555 0129",
    ticket: "A021",
    position: 3,
    waitMin: 30,
    chat: {
      emoji: "🐾",
      name: "Riaan",
      day: "Saturday",
      menu: [
        { name: "Check-up", price: 380, mins: 30 },
        { name: "Vaccination", price: 290, mins: 20 },
        { name: "Dental clean", price: 950, mins: 60 },
      ],
      times: ["08:00", "09:30", "11:00", "15:30"],
      ref: "V6J5QE",
      ticket: "Q019",
      ahead: 3,
      waitMin: 30,
    },
    brand: { main: "#2e6b3f", mainDeep: "#1f4a2b", accent: "#f2c14e", accentDeep: "#d9a02b", onAccent: "#2a1f05" },
  },
]
