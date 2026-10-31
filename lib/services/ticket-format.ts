// lib/services/ticket-format.ts
//
// The ONE place the customer-facing ticket number and booking reference formats
// are defined, shared by queue tickets (Q0001) and booking tickets (B0001).
//
//   Ticket number: <shop prefix> + a zero-padded running count, e.g. "B0001".
//   Queue tickets restart every day (queue_ticket_counters); booking tickets
//   keep counting for the life of the shop (booking_ticket_counters, assigned
//   by the bookings_assign_ticket_number trigger). The count is never capped:
//   past 9999 it just prints with more digits ("B10000").
//
//   Booking reference: 5 random characters, e.g. "H456R". It is what a customer
//   quotes and what the QR code carries, so it avoids look-alike characters
//   (no 0/O, 1/I). Still globally unique (bookings_booking_reference_key).

export const TICKET_NUMBER_DIGITS = 4
export const DEFAULT_BOOKING_NUMBER_PREFIX = "B"

export function formatTicketNumber(ticketNumber: number, prefix: string): string {
  return `${prefix}${String(ticketNumber).padStart(TICKET_NUMBER_DIGITS, "0")}`
}

export function formatBookingTicketNumber(
  ticketNumber: number,
  prefix: string = DEFAULT_BOOKING_NUMBER_PREFIX,
): string {
  return formatTicketNumber(ticketNumber, prefix)
}

// 32 characters, so one random byte maps onto it with no bias (byte & 31).
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
export const BOOKING_REFERENCE_LENGTH = 5

export function generateBookingReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(BOOKING_REFERENCE_LENGTH))
  return Array.from(bytes, (b) => REFERENCE_ALPHABET[b & 31]).join("")
}
