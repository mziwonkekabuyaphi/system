// print-agent/server.js
//
// Runs locally on the kiosk PC (Windows). Listens on 127.0.0.1:4000 and
// accepts POST /print-ticket from the kiosk web page (which is served
// from your hosted Next.js app, e.g. https://your-kiosk-domain.com).
//
// Printer connection: this assumes Epson's free "TM Virtual Port Driver"
// is installed and configured to expose the USB-connected TM-T88V as a
// TCP printer at 127.0.0.1:9100. That avoids needing libusb/Zadig driver
// swaps to talk to the printer directly over USB.
//   https://www.epson-biz.com/modules/pos/index.php?page=single_soft&cid=5779
//
// CORS: the kiosk page is HTTPS on a public domain; this agent is plain
// HTTP on localhost. Chromium treats http://127.0.0.1 as a secure
// fetch target from an HTTPS page (this is the standard pattern used by
// Square/other browser-based POS systems), but you still need to set
// CORS headers below so the browser's fetch isn't blocked by origin
// checks. Replace ALLOWED_ORIGIN with your real kiosk domain.

const express = require("express")
const { ThermalPrinter, PrinterTypes } = require("node-thermal-printer")

const PORT = 4000
const ALLOWED_ORIGIN = "https://your-kiosk-domain.com" // <-- set this to your real kiosk URL's origin
const PRINTER_ADDRESS = "tcp://127.0.0.1:9100" // TM Virtual Port Driver's local endpoint

const app = express()
app.use(express.json())

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.sendStatus(204)
  next()
})

// Simple health check so the kiosk can show "printer offline" instead of
// silently failing — call this before/alongside the actual print.
app.get("/health", (_req, res) => res.json({ ok: true }))

/**
 * Expected body shape (matches what submitKioskBooking / submitKioskQueueJoin
 * already return as `ticket` in actions.ts):
 *
 * Booking ticket:
 * {
 *   kind: "booking",
 *   ticketNumber: "A1B2C3D4",
 *   customerName: "Thabo",
 *   serviceName: "Hair Cut",
 *   dateLabel: "Today",
 *   slotLabel: "13:00"
 * }
 *
 * Queue ticket:
 * {
 *   kind: "queue",
 *   ticketNumber: "Q003",
 *   customerName: "Thabo",
 *   serviceName: "Hair Cut",
 *   position: 3,
 *   etaMinutes: 25
 * }
 *
 * shopName is sent separately since KioskPage already has tenant branding
 * in hand (branding.displayName) — no need to duplicate it server-side here.
 */
app.post("/print-ticket", async (req, res) => {
  const ticket = req.body?.ticket
  const shopName = req.body?.shopName || "QLess"

  if (!ticket || !ticket.kind || !ticket.ticketNumber) {
    return res.status(400).json({ ok: false, error: "Malformed ticket payload." })
  }

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: PRINTER_ADDRESS,
    removeSpecialCharacters: false,
    lineCharacter: "-",
    options: { timeout: 5000 },
  })

  try {
    const isConnected = await printer.isPrinterConnected()
    if (!isConnected) {
      return res.status(503).json({ ok: false, error: "Printer not reachable." })
    }

    printer.alignCenter()
    printer.setTypeFontB()
    printer.bold(true)
    printer.println(shopName)
    printer.bold(false)
    printer.drawLine()

    printer.newLine()
    printer.setTextSize(1, 1)
    printer.println(ticket.kind === "queue" ? "YOUR QUEUE NUMBER" : "YOUR BOOKING")
    printer.setTextSize(3, 3)
    printer.bold(true)
    printer.println(ticket.ticketNumber)
    printer.bold(false)
    printer.setTextSize(0, 0)
    printer.newLine()

    printer.alignLeft()
    printer.drawLine()
    printer.println(`Service: ${ticket.serviceName}`)
    if (ticket.customerName) printer.println(`Name: ${ticket.customerName}`)

    if (ticket.kind === "booking") {
      printer.println(`Date: ${ticket.dateLabel}`)
      printer.println(`Time: ${ticket.slotLabel}`)
    } else {
      printer.println(`Position in queue: ${ticket.position}`)
      printer.println(`Estimated wait: ~${ticket.etaMinutes} min`)
    }

    printer.drawLine()
    printer.alignCenter()
    printer.println(
      ticket.kind === "queue" ? "Please keep this ticket. We'll call your number." : "See you soon!",
    )
    printer.newLine()
    printer.cut()

    await printer.execute()
    return res.json({ ok: true })
  } catch (error) {
    console.error("[print-agent] Print failed", error)
    return res.status(500).json({ ok: false, error: "Print failed. Check the printer and paper." })
  }
})

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[print-agent] Listening on http://127.0.0.1:${PORT}`)
})
