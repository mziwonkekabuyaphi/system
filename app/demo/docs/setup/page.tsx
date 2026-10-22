import type { ReactNode } from "react";
import styles from "../docs.module.css";
import { DocsShell, SIGN_UP_URL, PRICING_URL, CONTACT_EMAIL } from "../DocsShell";

export const metadata = {
  title: "Set up, step by step — ZozoQueue docs",
  description:
    "From sign-up to your first live customer: opening hours, services, staff, booking and queue rules, WhatsApp, the kiosk, the waiting-area screen, clock-in and a go-live test.",
};

// Copy lives in these lists so it can be edited without touching the layout.
// Every fact here was checked against the product code or the other docs pages. Where a step has no
// "where" line, the exact screen name has not been confirmed yet.

/** What to have ready before step 1. */
const BEFORE: string[] = [
  "Your business name, exactly as you want customers to see it.",
  "Your opening hours for each day of the week, including which days you are closed.",
  "A list of your services, each with a price and how many minutes it takes.",
  "Your staff: names, job titles, how each person is paid (hourly, commission or hybrid) with the rate or percentage, and a clock-in PIN of 4 to 6 digits for each person (every PIN different).",
  "If you want WhatsApp: a number that isn’t already used in the WhatsApp or WhatsApp Business app, and a Meta (Facebook) login. Meta bills you directly for WhatsApp messages, and you add a payment method in WhatsApp Manager.",
  "A tablet for the kiosk and clock-in page, and a TV with a web browser for the waiting-area screen. A ticket printer is optional.",
  "A decision on who needs a dashboard login, and whether each person should be Owner / Admin or Staff.",
];

const STEPS: Array<{
  title: string;
  text: ReactNode;
  items?: string[];
  where?: ReactNode;
  detail?: ReactNode;
  check: ReactNode;
  mistake?: ReactNode;
}> = [
  {
    title: "Create your account",
    text: (
      <>
        <a href={SIGN_UP_URL}>Sign up</a>, name your business and you land in the dashboard. You can start on the free
        plan and upgrade later (<a href={PRICING_URL}>see plans</a>).
      </>
    ),
    where: "The sign-up page, then the “One more step” page that follows it.",
    detail:
      "You sign up with your full name, work email and a password of at least 8 characters. If we ask you to confirm your email, follow the link we send and you arrive at the same next page. There you either create a business or join one with an invite code. Creating a business only needs its name, and your shop’s web address is made from it. You become the owner of what you create.",
    check: "You can see your dashboard, and it shows your business name.",
    mistake:
      "Creating a second business when a colleague already set one up. If someone invited you, choose “Join with a code” instead of “Create a business”.",
  },
  {
    title: "Set your opening hours",
    text: "In Settings, set an open and close time for each weekday and mark closed days. Also check your time zone and currency (ZAR by default).",
    items: ["Kiosk walk-ins and WhatsApp bookings are only accepted inside these hours."],
    where: "Settings. The Opening Hours page has the times, and Business Info has the time zone and currency.",
    detail:
      "Each weekday has a Closed tick box and an open and close time. Times are read in the time zone set in Business Info, and that time zone is also used for booking availability, cancellation cut-offs and confirmations. It is a text field, so type it carefully.",
    check: "Each weekday shows the times you expect, and closed days are marked closed.",
    mistake:
      "Leaving a wrong closing time, such as Saturday, or a wrong time zone. Slots are only offered inside your opening hours, so a wrong time shows up as missing or shifted slots.",
  },
  {
    title: "Add your services",
    text: "Each service has a name, a price, a duration in minutes and an active switch. Duration decides which time slots are offered.",
    items: [
      "Don’t need services? Turn off “require service selection” for bookings or for the queue and set a default duration instead.",
    ],
    detail:
      "A slot is only offered when a staff member is free for the full duration of the service, so enter how long the job really takes. The two switches are separate. On the Booking page, turn off “Require a service to book” and set “Appointment length with no service” (5 to 480 minutes). On the Queue page, turn off “Require a service to join the queue” and set the estimated minutes to serve a walk-in. Bookings made without a service show as “No service” in Today and Bookings.",
    check: "Every service you sell is listed, switched on, and has the right duration.",
    mistake:
      "Skipping services when appointments still need one. The kiosk then skips the service screen and offers only the walk-in queue.",
  },
  {
    title: "Add your staff",
    text: "Add each person with a name, job title and how they are paid: hourly, commission or hybrid. Give them a clock-in PIN (unique within your shop). Phone, email, employee number and start date are optional.",
    items: [
      "Link a staff member to a sign-in only if they need to open the dashboard.",
      "How many active staff you can have depends on your plan.",
      "Hourly: paid for the hours they clock in. Commission: paid a percentage of the price of the services they do. Hybrid: hourly and commission together, either with commission on top of the hourly pay, or whichever of the two is higher, which works as a guaranteed minimum.",
      "Commission is worked out on the price you list for each service, when the customer is marked as served. Tips and discounts aren’t included, and walk-ins only count once a staff member is recorded as serving them.",
      "The pay fields, and ID, SARS tax number and bank details, only show for Owner / Admin logins. After saving, only the last four characters of an ID or bank account number are shown.",
      "To give someone a sign-in, enter their email and a password of at least 8 characters on the staff form. A person created this way gets the Staff role. To choose Owner / Admin, invite them instead (step 12).",
    ],
    detail: (
      <>
        Your staff list is everyone who works for you, and a dashboard login is only for people who need to open
        ZozoQueue itself. Read <a href="/demo/docs/team">Roles &amp; access</a> for the difference.
      </>
    ),
    check:
      "Everyone appears in your staff list as active, with a PIN set. If you are Owner / Admin, each line also shows how they are paid, for example an hourly rate or a commission percentage.",
    mistake:
      "Giving two people the same PIN, or one that isn’t 4 to 6 digits. A PIN must be unique in your shop, or one of them can’t clock in. Also leaving the pay type or rate wrong: commission and hybrid need a commission rate between 0 and 100%, and an employee paid only on commission must still receive at least the national minimum wage. To guarantee a floor, choose hybrid with “whichever is higher” and set an hourly rate, and check the rules with your accountant.",
  },
  {
    title: "Choose your booking rules",
    text: (
      <>
        Decide how far ahead and how late customers can book, how many services fit in one booking, and when cancelling is still allowed. See the{" "}
        <a href="/demo/docs/reference">settings reference</a> for every option.
      </>
    ),
    items: [
      "Minimum notice to book, in minutes, and how far ahead customers can book, in days. Set days ahead to 0 for same-day booking only.",
      "Dates shown to customers (1 to 14) is how many date buttons the kiosk and WhatsApp list. The smaller of that and the days-ahead limit applies.",
      "Services per booking (1 to 5). The kiosk lets customers tick up to that many, and WhatsApp keeps offering one.",
      "Allow customers to choose staff is off by default. When it is on, customers can ask for a person on WhatsApp, for example “book with Sipho”, and are only offered times that person is free.",
      "Booking reminders are on by default. They go out a set time before the appointment (30 to 1440 minutes, 120 by default) with buttons to confirm or say they can’t make it.",
      "Link bookings to the queue puts confirmed bookings into the walk-in queue shortly before they start, so your team sees one line. It is checked about once a minute. Queue priority then sets the order: first come first served, honour the appointment time, or first come but flag it.",
    ],
    where: "Settings, on the Booking page.",
    detail:
      "Four choices matter most: how far ahead customers can book, the minimum notice before a slot, how many services fit in one booking, and the cancellation cut-off. The cut-off is 60 minutes before the start by default. Booking reminders go out a set time before the appointment, two hours by default.",
    check: "Try a booking on your own number: a slot inside your window is offered, and one outside it isn’t.",
    mistake:
      "Setting a long minimum notice and then wondering why today’s slots are gone. Slots only appear after the minimum notice. Also keep the free cancellation window shorter than the reminder time: otherwise a customer who taps “Can’t make it” is told it is too late to cancel, and the page shows a warning.",
  },
  {
    title: "Choose your queue rules",
    text: "Pick a ticket prefix (Q gives Q001, Q002…), an optional maximum queue size, and which doors can join: WhatsApp, kiosk or both. Turn on auto-call if you want the next person called automatically.",
    items: [
      "Auto-call next calls the next customer when a slot frees up.",
      "“Notify a customer this many people before their turn” decides when the “nearly their turn” message is sent.",
      "Allow walk-ins via WhatsApp and via the kiosk are two separate switches.",
      "Require a service to join the queue: if on, you also set how many services one ticket can have (1 to 5). If off, you set the estimated minutes to serve a walk-in.",
      "The ticket prefix is 1 to 4 characters and is shown in capitals on printed kiosk tickets and WhatsApp confirmations.",
    ],
    where: "Settings, on the Queue page (the card is called “Walk-in line”).",
    detail:
      "Ticket numbers start again at 001 each day, with the prefix you chose. Leave the maximum queue size empty for no limit.",
    check: "Join the queue from a door you enabled: you get a ticket with your prefix and a number.",
    mistake:
      "Setting a small maximum queue size and forgetting it. Once it is full, the queue won’t take anyone else. Also check that the door you plan to use is switched on.",
  },
  {
    title: "Connect your WhatsApp number",
    text: "ZozoQueue connects to Meta’s official WhatsApp Cloud API using a number that belongs to your business. You can use Meta’s guided sign-up or enter the connection details manually.",
    items: [
      "A new connection shows as pending until Meta verifies it, then becomes active.",
      "If your number is currently in the regular WhatsApp app, talk to us first so nothing is interrupted.",
      "If you don’t see WhatsApp under Modules, it isn’t part of your plan yet.",
    ],
    where:
      "Settings, on the WhatsApp messages page: the WhatsApp connection card is at the top. If your plan includes WhatsApp and you are the owner, you are also offered it right after you create your business, and you can press “Skip for now”.",
    detail:
      "Only the business owner can connect WhatsApp. The guided sign-up opens a Meta (Facebook) pop-up where you sign in and choose or create your WhatsApp Business account. We never see your Meta password. A shop has one WhatsApp number at a time. The button reads “Connect WhatsApp” at first, “Finish connecting” if setup was started but not finished, “Try again” after an error, and “Reconnect or change number” once connected. If you connect a different number, your current one stops receiving customer messages, and you are asked to confirm first. If we set the connection up for you, the card says “Set up for you by ZozoQueue”. If the button is missing, the card says why: only the owner can connect, WhatsApp isn’t in your plan, or it isn’t available on the platform yet.",
    check: "The badge changes from “Setting up” to “Connected”, and your number appears next to it.",
    mistake: (
      <>
        Closing the pop-up half-way. The badge then says “Setting up”: press Finish connecting. If it says “Needs
        attention”, read the error shown and press Try again. See{" "}
        <a href="/demo/docs/troubleshooting#whatsapp">troubleshooting</a>.
      </>
    ),
  },
  {
    title: "Review your WhatsApp messages",
    text: "Six messages go out automatically: queue joined, almost your turn, called, booking confirmation, booking reminder and waitlist slot open. Meta reviews each wording before it can be sent.",
    items: [
      "Each message has an on/off switch of its own.",
      "Reminders default to two hours before the appointment; you can change the lead time.",
    ],
    where:
      "Settings, on the WhatsApp messages page, under the connection card, in “Messages to customers who haven’t messaged you”. All six messages are listed there.",
    detail:
      "Each message shows a status: Not submitted, In review at Meta, Approved, Rejected, Paused by Meta or Disabled. You can edit the wording (up to 1,024 characters) and see a preview. Press Save wording, then Submit to Meta, and press Refresh status to check on it. You can’t edit a message while it is in review. If the page says no templates are set up yet, press Set up default templates. Each message needs at least one placeholder such as {{1}}, numbered in order with no gaps, with words between them, and it can’t start or end with a placeholder. If you change the wording of a message you have already sent to Meta, it becomes a new version marked Not submitted, so press Submit to Meta again. Until the new version is approved, customers who haven’t messaged you in the last 24 hours won’t receive it. A reminder reaches a customer who messaged you in the last 24 hours as a normal message. Everyone else only gets it if they agreed to WhatsApp updates and your reminder wording has been approved.",
    check: "Each message you want to use shows as Approved and switched on. Press Refresh status if one is still in review.",
    mistake:
      "Writing promotional wording. Keep each message plain and about the visit itself, or Meta re-labels it “Marketing”, which costs more. If a wording is rejected, the reason is shown under the message: edit it and submit it again. Also, don’t switch off the “It’s their turn” message unless you tell customers another way.",
  },
  {
    title: "Set up the kiosk",
    text: "Open your shop’s kiosk link on a tablet. Choose whether it offers bookings, the queue or both, rename the buttons and screens, and pick which details to ask for: name, surname, phone, email or one custom question.",
    items: [
      "The WhatsApp updates tick box is never pre-ticked. Customers without WhatsApp can still join.",
      "Add your logo, colours and a short tagline. Removing “Powered by ZozoQueue” is a Business-plan option.",
      "Customer options are Booking and Queue, Booking Only, or Queue Only. Only “Booking and Queue” shows the choice screen where customers pick between the two.",
      "Under Local terms you can reword every screen in the order customers see it: welcome (the tagline), choice, service, date and time, details, and the final ticket. Leave a field empty to use the default.",
      "The details screen can ask for name (at least 2 letters), surname, cellphone number (10 digits), email and one custom question of your own. Email and the custom question can each be made compulsory. The cellphone number is always asked, because bookings and the queue identify customers by it.",
      "The WhatsApp tick box only appears if your WhatsApp is connected. Turn it off to hide it: no new customers can opt in at the kiosk, and the kiosk stops sending its own WhatsApp confirmation.",
      "Timing: the idle reset (10 to 600 seconds) sends the kiosk back to the welcome screen when nobody is using it, and the confirmation screen (3 to 120 seconds) sets how long the ticket stays up.",
    ],
    where:
      "Settings, on the Kiosk page. Switch on “Kiosk module” first. The kiosk address is on the same page, with a Copy button, an “Open the kiosk” link and a QR code. Print it on a table stand, or open it directly on the kiosk tablet.",
    detail:
      "Your display name, logo and colours are set once under Private Label and are used on the kiosk, the TV screen and the clock-in pad. A logo can be PNG, JPEG, WebP or SVG, up to 2 MB. A custom logo and brand colours are a Business-plan feature, but your display name can be changed on any plan. If the kiosk isn’t in your plan, the page shows a locked card and points you to Plans & Billing.",
    check: "Join the queue from the tablet as a test customer. The screens ask only for the details you chose.",
    mistake: (
      <>
        A missing booking or queue button. Check that “Kiosk module” is on, the customer option (Booking and Queue, Booking Only or Queue Only), that the matching module is on for your plan, and that
        you are inside opening hours. The kiosk also refuses to save details settings that leave customers nothing to
        fill in, or a custom question with no name. If you use a ticket printer, see{" "}
        <a href="/demo/docs/troubleshooting#printing">ticket printing</a>.
      </>
    ),
  },
  {
    title: "Set up the waiting-area screen",
    text: "Open your display link on a TV and leave it on. Choose rotating slides, a live board or a split view, a dark, light or custom colour theme, and which queue details appear. Changes reach the screen by themselves within seconds.",
    items: [
      "Rotating slides shows one big screen at a time. Live board shows everything at once. Split screen shows who is being served on the left and who is still to come on the right.",
      "You choose which screens appear: your menu, upcoming bookings and the live queue. A screen with nothing to show is skipped automatically.",
      "Queue ticket details are separate switches: ticket number, service, cellphone number, surname, email, the answer to your custom kiosk question, estimated wait, time waited and booking reference.",
      "When you call a customer, the TV can take over the whole screen to show their ticket for a few seconds (3 to 60, you choose), then go back to what it was showing.",
      "Every piece of text on the TV can be reworded under Local terms.",
    ],
    where:
      "Settings, on the Display page. It shows your screen address with a Copy button, a QR code and an “Open the screen” link.",
    detail:
      "Switch on “Public display module” first, or the screen shows nothing. The screen is public, so cellphone number and email are off by default. A cellphone number is always shown masked, and an email partly hidden. The answer to your custom question is shown exactly as typed, so only turn it on if everyone in the waiting area may read it. For an email to appear, you also need to ask for email on the kiosk.",
    check: "Join the queue from the kiosk and watch the TV: the new ticket appears within seconds.",
    mistake:
      "Leaving the TV offline or on the wrong page, or the display module switched off. The TV must be online and open on your shop’s display link. If it looks stuck, reload the page.",
  },
  {
    title: "Turn on clock-in and payroll",
    text: "Put the clock-in page on a shared tablet. Staff enter their PIN to clock in and out. In payroll, choose hourly, commission or hybrid pay, add your employer details, then calculate a period and mark it paid.",
    where:
      "Settings, on the staff clock-in page: switch on “Staff clock-in module”, then open the clock-in address on the shared tablet. It has a Copy button and a QR code, and you can also change the theme and reword what staff see. The staff screen in the dashboard shows the same link, so you can print it by the staff entrance or bookmark it.",
    detail:
      "No login is needed on the clock-in pad, only the PIN. Payroll, including hours, pay and payslips, is only visible to Owner / Admin logins. PAYE and UIF figures are estimates: check them with your accountant before you pay anyone. If someone forgets to clock out, an Owner / Admin can force a clock-out from “Currently clocked in” on the staff screen.",
    check: "Clock one person in and out with their PIN, and see the time appear for them.",
    mistake:
      "Leaving the clock-in module switched off: staff then can’t clock in or out. Also a person who can’t clock in: check that they are active, that their PIN is set, and that nobody else in your shop has the same PIN.",
  },
  {
    title: "Invite your team",
    text: "Send an invite code to each person who needs the dashboard. Codes expire after 7 days. Pick Owner/Admin or Staff for each.",
    detail:
      "Each code works once. You can add the person’s email address when you create it, and then only that email can use it. The person signs up, chooses “Join with a code” on the “One more step” page, and enters the code. They then see only your business. If you instead create someone on the staff screen with an email and password (step 4), they get the Staff role and need no code.",
    check: "The person appears in your team with the role you chose, and can open the dashboard.",
    mistake: (
      <>
        Sending a code that has expired or was already used, or one made for a different email address. Make a new
        code. See <a href="/demo/docs/team">Roles &amp; access</a> for what each role can open.
      </>
    ),
  },
  {
    title: "Test, then go live",
    text: "Run through one real visit of each type before you announce it.",
    items: [
      "Message your WhatsApp number and book an appointment.",
      "Cancel it and check the waitlist or slot behaves as expected.",
      "Join the queue from the kiosk, then call the number from the dashboard.",
      "Check the TV shows the call and that the customer received their WhatsApp message.",
      "Clock one staff member in and out.",
    ],
    check: "Every item in the go-live checklist below is ticked.",
    mistake:
      "Testing only the happy path. Also try a cancellation and a joining attempt outside opening hours, so you know what customers will see.",
  },
];

/** The fuller checklist, grouped. Tick these off the day before you open to customers. */
const CHECKLIST: Array<{ title: string; items: string[] }> = [
  {
    title: "Your shop",
    items: [
      "Opening hours and closed days are right, and the time zone in Business Info is correct.",
      "Every service is active with the right duration.",
      "Every staff member is active with a unique PIN and the right pay type.",
    ],
  },
  {
    title: "Rules",
    items: [
      "Booking window, minimum notice and cancellation cut-off match how you really work.",
      "The cancellation window is shorter than the reminder time.",
      "Ticket prefix is set, and the maximum queue size is what you want (or empty).",
    ],
  },
  {
    title: "WhatsApp",
    items: [
      "The badge says Connected, with the right number.",
      "Each message you use is approved and switched on.",
      "A test booking, a test cancellation and a test queue message all arrived.",
    ],
  },
  {
    title: "In the shop",
    items: [
      "The kiosk tablet shows the buttons you expect and asks only for the details you chose.",
      "If you use a ticket printer, a test ticket printed once.",
      "The Public display module is on, and the TV shows a new ticket within seconds.",
      "The Staff clock-in module is on, and staff clocked in and out with their own PINs.",
    ],
  },
  {
    title: "People",
    items: [
      "Everyone who needs the dashboard has the right role.",
      "Only Owner / Admin logins can see payroll, and you are happy with who they are.",
    ],
  },
];

export default function SetupPage() {
  return (
    <DocsShell current="setup">
      <div className={styles.block}>
        <h1>Set up, step by step</h1>
        <p>Follow these in order. Each step takes minutes, and you can go live with only the first six if you don’t use WhatsApp yet.</p>
      </div>

      <nav aria-label="On this page">
        <ul className={styles.jump}>
          <li><a href="#before">Before you start</a></li>
          <li><a href="#steps">The 13 steps</a></li>
          <li><a href="#go-live">Go-live checklist</a></li>
          <li><a href="#after">After you go live</a></li>
        </ul>
      </nav>

      <div id="before" className={`${styles.block} ${styles.detail}`}>
        <h2>Before you start</h2>
        <p>Having these to hand makes each step quicker.</p>
        <ul className={styles.points}>
          {BEFORE.map((b) => <li key={b}>{b}</li>)}
        </ul>
        <p className={styles.note}>
          You don’t need everything at once. You can add WhatsApp, the kiosk and the screen later, and come back to
          this page when you do.
        </p>
      </div>

      <div id="steps" className={styles.block}>
        <h2>The 13 steps</h2>
        <p>Each step says what to do, where to find it, how to check it worked and what people most often get wrong.</p>
        <ol className={styles.steps}>
          {STEPS.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              {s.where && <p><strong>Where:</strong> {s.where}</p>}
              {s.detail && <p>{s.detail}</p>}
              {s.items && (
                <ul>
                  {s.items.map((i) => <li key={i}>{i}</li>)}
                </ul>
              )}
              <p><strong>Check it worked:</strong> {s.check}</p>
              {s.mistake && <p><strong>Common mistake:</strong> {s.mistake}</p>}
            </li>
          ))}
        </ol>
      </div>

      <div id="go-live" className={`${styles.block} ${styles.detail}`}>
        <h2>Go-live checklist</h2>
        <p>Work through this the day before you tell customers. It covers the same ground as the test in step 13, in more detail.</p>
        {CHECKLIST.map((g) => (
          <div key={g.title}>
            <h3>{g.title}</h3>
            <ul className={styles.points}>
              {g.items.map((i) => <li key={i}>{i}</li>)}
            </ul>
          </div>
        ))}
        <p className={styles.note}>
          Not sure a feature is on your plan? <a href={PRICING_URL}>See what each plan includes</a>.
        </p>
      </div>

      <div id="after" className={styles.block}>
        <h2>After you go live</h2>
        <p>
          Something not behaving? Start with <a href="/demo/docs/troubleshooting">Troubleshooting</a>, which is grouped
          by where you see the problem. The <a href="/demo/docs/reference">settings reference</a> lists every booking
          and queue option, and <a href="/demo/docs/billing">Visits &amp; billing</a> explains how a visit is counted.
          If you are still stuck, email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
        <div className={styles.pagers}>
          <a className={styles.pager} href="/demo/docs/pieces">
            <span>Previous</span>
            ← The pieces
          </a>
          <a className={`${styles.pager} ${styles.pagerNext}`} href="/demo/docs/reference">
            <span>Next</span>
            Settings reference →
          </a>
        </div>
      </div>
    </DocsShell>
  );
}
