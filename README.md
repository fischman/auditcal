# auditcal

Zero-dependency static webapp (plain HTML/CSS/JS, no build step) that audits the
notifications/reminders on your Google Calendar events for the **current and next
week** (each week = Monday–Sunday, local time), and lets you "bless" the
name+notification combinations you consider correct.

## What it does

- OAuth into Google (read-only) using Google Identity Services.
- Lists every event on your **primary** calendar between Monday of this week and
  Sunday of next week, ordered by day/time, grouped by day.
- Each event is a single-line row: time, event name (bounded width, horizontally
  scrollable if long), and the notifications set on it (resolving "use default"
  reminders to the calendar's actual default reminders). Rows with no
  notifications are flagged.
- A page-level "Show blessed events" toggle (default off) hides already-blessed
  events so you can focus on what still needs review.
- Click a row to open it in Google Calendar (`htmlLink`).
- "Bless" a row with the ✓ button: its **name + exact notification set** is saved
  to `localStorage` and persists across page loads. Blessed rows get green
  styling. Any other row with the same name AND same notifications is also shown
  as blessed. Use the ✕ button to unbless.

## Permissions (minimal, read-only)

- `calendar.readonly` — read events on the primary calendar incl. reminders and
  the calendar's default reminders.

No write scopes are requested. The OAuth token is held only in memory; it is not
persisted. The only persisted data is your Client ID and your blessed list, both
in this browser's `localStorage`.

## Setup

1. In Google Cloud Console, create an OAuth 2.0 **Client ID** of type *Web
   application*.
2. Enable the **Google Calendar API** for the project.
3. Add the origin where you serve this app (e.g. `http://localhost:8000` or your
   exe.dev proxy origin) to the client's **Authorized JavaScript origins**.
4. Serve the folder statically, e.g.:

   ```sh
   busybox httpd -f -p 8000 -h .
   # or: python3 -m http.server 8000
   ```

5. Open the page, paste the Client ID, click **Save**, then **Connect Google
   Calendar**.

## Notes / limitations

- Only the **primary** calendar is scanned.
- Recurring events are expanded (`singleEvents=true`) so each instance in range is
  audited individually.
- A blessed entry matches on event name + notification signature. Renaming an
  event or changing its reminders makes it unblessed again (by design — that's the
  point of the audit).

## Files

- `index.html` — markup + GSI script tag
- `style.css` — styling
- `app.js` — OAuth, data loading, rendering, blessing logic
