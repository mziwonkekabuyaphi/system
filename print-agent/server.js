// print-agent/server.js
//
// Runs on the kiosk PC (Windows). Listens on 127.0.0.1:4000 and prints
// tickets to the Epson TM-T88V through the TM Virtual Port Driver's COM port.
//
// Quick test without the kiosk: open http://127.0.0.1:4000/test-print
// in a browser on this PC. A sample slip should print.

const express = require("express")
const { ThermalPrinter, PrinterTypes } = require("node-thermal-printer")
const { SerialPort } = require("serialport")

// ===================== CHANGE THESE TWO THINGS =====================
// 1) The COM port shown next to your TM-T88V in the
//    "EPSON TM Virtual Port Driver Manager" (for example "COM3").
const COM_PORT = "COM3"

// 2) The address of your kiosk website (just the start, no path).
//    Example: "https://my-kiosk.vercel.app"
const ALLOWED_ORIGINS = ["https://system-eta-azure.vercel.app", "http://localhost:3000"]
// ===================================================================

const PORT = 4000

const app = express()
app.use(express.json())

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin)
  res.setHeader("Vary", "Origin")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  res.setHeader("Access-Control-Allow-Private-Network", "true")
  if (req.method === "OPTIONS") return res.sendStatus(204)
  next()
})

// Builds the printer commands for a ticket (nothing is sent yet).
function buildTicketBuffer(ticket, shopName) {
  // The interface below is never used to connect; we only build the bytes
  // and send them ourselves to the COM port.
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: "tcp://127.0.0.1:9100",
    removeSpecialCharacters: false,
    lineCharacter: "-",
  })

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
  if (ticket.serviceName) printer.println(`Service: ${ticket.serviceName}`)
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

  return printer.getBuffer()
}

// Sends raw bytes to the printer's COM port.
function sendToPort(buffer) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path: COM_PORT, baudRate: 115200 }, (openError) => {
      if (openError) return reject(openError)
      port.write(buffer, (writeError) => {
        if (writeError) {
          port.close()
          return reject(writeError)
        }
        port.drain(() => port.close(() => resolve()))
      })
    })
  })
}

app.get("/health", (_req, res) => res.json({ ok: true }))

// Open this in a browser on the kiosk PC to print a sample slip.
app.get("/test-print", async (_req, res) => {
  try {
    const sample = {
      kind: "queue",
      ticketNumber: "Q001",
      customerName: "Test",
      serviceName: "Test Service",
      position: 1,
      etaMinutes: 5,
    }
    await sendToPort(buildTicketBuffer(sample, "Test Shop"))
    res.send("Test ticket sent to the printer.")
  } catch (error) {
    console.error("[print-agent] Test print failed", error)
    res.status(500).send(`Test print failed: ${error.message}`)
  }
})

app.post("/print-ticket", async (req, res) => {
  const ticket = req.body?.ticket
  const shopName = req.body?.shopName || "QLess"

  if (!ticket || !ticket.kind || !ticket.ticketNumber) {
    return res.status(400).json({ ok: false, error: "Malformed ticket payload." })
  }

  try {
    await sendToPort(buildTicketBuffer(ticket, shopName))
    return res.json({ ok: true })
  } catch (error) {
    console.error("[print-agent] Print failed", error)
    return res.status(500).json({ ok: false, error: `Print failed: ${error.message}` })
  }
})

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[print-agent] Listening on http://127.0.0.1:${PORT}`)
  console.log(`[print-agent] Printing to ${COM_PORT}`)
})
