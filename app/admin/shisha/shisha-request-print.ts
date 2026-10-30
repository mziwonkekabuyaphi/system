// app/admin/shisha/shisha-request-print.ts
//
// Client-side helper: prints a "new session requested" slip on the shop's receipt
// printer through the local print agent (the same agent the receipts use, listening
// on 127.0.0.1:4000 on the PC the printer is plugged into). Only works from a browser
// ON that PC, from the origin the agent allows (CORS). No server-only imports.

const PRINT_AGENT_URL = "http://127.0.0.1:4000"
const AGENT_TIMEOUT_MS = 25_000 // the very first print after an agent restart can be slow

export type SlipResult = "printed" | "unreachable" | "timeout" | "failed"

export interface RequestSlip {
  /** The agent never prints the same jobId twice within ~30s. */
  jobId: string
  customer: string
  phone: string | null
  station: string | null
  flavour: string
  /** Pre-formatted price, or null when unknown. */
  amountText: string | null
  dateText: string
}

/** en-ZA formatting uses non-breaking spaces, which thermal printers print as junk. */
export const toPlain = (v: string): string => v.replace(/[\u00a0\u202f]/g, " ")

export async function printRequestSlip(slip: RequestSlip, shopName: string): Promise<SlipResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS)
  try {
    const res = await fetch(`${PRINT_AGENT_URL}/print-shisha-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ shopName, slip }),
    })
    return res.ok ? "printed" : "failed"
  } catch (e) {
    // Aborted = the agent may still be printing: report it, don't retry on our own.
    if (e instanceof DOMException && e.name === "AbortError") return "timeout"
    return "unreachable" // refused / blocked: no agent on this PC
  } finally {
    clearTimeout(timer)
  }
}

/** Staff-facing reason a slip didn't (clearly) print. */
export function slipProblem(result: SlipResult, who: string): string | null {
  switch (result) {
    case "printed":
      return null
    case "unreachable":
      return `Couldn't print the slip for ${who}: the receipt printer isn't reachable from this PC.`
    case "timeout":
      return `The printer didn't answer in time for ${who}'s slip. Check whether it came out before reprinting.`
    default:
      return `The printer reported a problem printing ${who}'s slip. Check the paper and cover, then use Print slip.`
  }
}
