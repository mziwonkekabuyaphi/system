# QLess Print Agent

A tiny local helper that runs on the kiosk PC and prints queue/booking
tickets to an Epson TM-T88V (USB) whenever the kiosk web app calls it.

## Why this exists

Your kiosk web page is served from your hosted Next.js app (a remote
server). A browser tab has no way to talk to a USB printer plugged into
the PC it's running on. This agent runs *on that PC*, listens on
`localhost`, and does the USB/printer work the browser can't.

## One-time setup on the kiosk PC (Windows)

1. **Install Epson's TM Virtual Port Driver.**
   Download from Epson's POS support site (search "TM Virtual Port
   Driver" for your printer model). Install it, plug in the TM-T88V via
   USB, and configure the driver to expose the printer as a virtual TCP
   port at `127.0.0.1:9100`. This lets us talk to the USB printer like a
   normal network printer — no libusb/Zadig driver replacement needed.
   Print a test page from the driver's utility to confirm it works
   before moving on.

2. **Install Node.js** (LTS) on the kiosk PC if it isn't already there.

3. **Copy this `print-agent` folder onto the kiosk PC**, then in a
   terminal inside it:
   ```
   npm install
   ```

4. **Edit `server.js`:** set `ALLOWED_ORIGIN` to your real kiosk URL's
   origin (e.g. `https://qless.yourdomain.com`), and confirm
   `PRINTER_ADDRESS` matches the port the Virtual Port Driver is using
   (default `tcp://127.0.0.1:9100`).

5. **Run it:**
   ```
   npm start
   ```
   You should see `Listening on http://127.0.0.1:4000`. Leave this
   running — see "Auto-start" below to make that automatic.

## Auto-start on boot (so nobody has to remember to launch it)

Two good options:

- **Simplest:** Task Scheduler → create a task that runs
  `node C:\path\to\print-agent\server.js` "At log on", with "Run whether
  user is logged on or not" if you want it before anyone touches the
  kiosk.
- **More robust:** install it as an actual Windows Service using
  [`node-windows`](https://www.npmjs.com/package/node-windows), so it
  survives without any user session at all.

Also set the kiosk browser (Chrome/Edge) to launch in kiosk mode at
startup pointed at your `/kiosk/[slug]` URL, e.g.:
```
chrome.exe --kiosk https://qless.yourdomain.com/kiosk/your-slug
```

## Calling it from the kiosk app

After `submitKioskBooking` / `submitKioskQueueJoin` returns a ticket,
call this agent client-side (in the browser, not a Server Action — the
Server Action runs on your Next.js host, not the kiosk PC):

```ts
async function printTicket(ticket: KioskBookingTicket | KioskQueueTicket, shopName: string) {
  try {
    const res = await fetch("http://127.0.0.1:4000/print-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, shopName }),
    })
    if (!res.ok) {
      console.warn("[kiosk] Ticket print failed, continuing without it")
      return false
    }
    return true
  } catch (error) {
    // Agent not running / printer off — never block the on-screen ticket
    console.warn("[kiosk] Print agent unreachable", error)
    return false
  }
}
```

Call this right after you get the ticket back and show the on-screen
confirmation regardless of whether printing succeeded — treat the paper
ticket as a bonus, not a dependency, the same way the WhatsApp
confirmation in `submitKioskBooking` is best-effort. If `printTicket`
returns `false`, show something like "Please note your number: {ticketNumber}"
on screen so the flow still works with the printer off or out of paper.

## Ticket format

Currently prints: shop name, a large queue/booking number, service,
customer name, and either date+time (booking) or position+ETA (queue),
then cuts the paper. Adjust the layout in `server.js`'s `/print-ticket`
handler — `node-thermal-printer` also supports barcodes/QR codes
(`printer.printQR(...)`) if you later want the ticket to link to a
"check your status" page.
