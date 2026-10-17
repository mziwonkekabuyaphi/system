// lib/services/messages/booking-staff.ts
/**
 * Customer-facing copy for "book with <staff member>". Same plain, friendly style as
 * lib/services/messages/booking.ts. English only for now, like the rest of that file's builders.
 */

export function staffRequestedLine(name: string): string {
  return `👤 With ${name}`
}

export function staffInactiveMessage(name: string): string {
  return `Sorry, ${name} isn't taking bookings right now. Send "book" and I'll book you with the first available team member instead.`
}

export function staffAmbiguousMessage(names: string[]): string {
  const list = names.join(", ")
  return `More than one team member matches that name (${list}). Please send the full name, for example "book with ${names[0]}".`
}

export function staffNoSlotsMessage(name: string): string {
  return `${name} has no free times on that day. Pick another day below, or send "book" to book with anyone who is free.`
}

export function staffNoLongerAvailableMessage(name: string): string {
  return `Sorry, ${name} is no longer available at that time. Please send "book" to choose another time.`
}

export function staffChoiceOffMessage(): string {
  return `This shop now assigns staff automatically, so I can't book you with a specific person. Please send "book" to start again.`
}
