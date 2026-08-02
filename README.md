# 🚕 Flying Eagle - WhatsApp B2B Outstation Operations Engine & Operations Dashboard

A B2B fleet booking and automated dispatch platform for outstation car rentals. Customers book entirely over WhatsApp by describing their trip in plain English (understood via **Google Gemini**), the bot auto-calculates distance and fare, and dispatch automatically offers the trip to your own fleet first before falling back to tie-up partners - all backed by a **Node.js (Express)** + **SQLite** operations dashboard.

---

## 🌟 Key Features

1. **Conversational WhatsApp Booking Bot** (Gemini-powered):
   - Customers text `Hi` and describe their trip in their own words - e.g. *"Chennai to Madurai this Friday for 2 days, need an SUV"*.
   - The bot extracts whatever it can and asks only for what's still missing, understands natural-language dates (*"next Monday"*, *"tomorrow"*) via `chrono-node`, and stays silent on spam/other bots instead of replying to everything (AI intent detection + a no-progress loop-guard).
   - Distance is auto-calculated from the pickup/drop text via **OpenRouteService**, then confirmed in a single final summary alongside the fare - no separate back-and-forth for distance.
2. **Own-Fleet-First Dispatch**:
   - A confirmed booking is offered to your own fleet first via WhatsApp ACCEPT/DECLINE. Only on an explicit decline (or if no internal vehicle covers that category) does it broadcast to tie-up partners.
   - Partners can report their **live availability and location** in free text (*"Sedan available in Chennai today"*) - unavailable partners are skipped, and available ones are offered nearest-first.
   - Partner driver-detail replies require the booking reference, so a partner juggling multiple trips can't misassign a driver.
3. **Dynamic Vehicle-Type Catalog**:
   - Vehicle types aren't hardcoded - add new ones (with a description) or edit existing rates from the dashboard, and every booking surface (WhatsApp bot, admin dashboard, public customer page) picks them up immediately.
4. **Customer Self-Service, Two Ways**:
   - The WhatsApp bot above, or a public web booking form (`/book.html`) for sharing on Google My Business/Instagram/your website.
5. **Single-Page Operations Dashboard**:
   - **Live Operations Board**: track pending, offered, broadcast, assigned, and in-progress trips; edit/delete bookings.
   - **Rate Card Manager**: add/edit/delete vehicle types and pricing.
   - **Fleet & Partner Directory**: manage partners, see live availability status, accept/decline own-fleet offers, and instantly resend a partner's last-known driver without retyping it.
   - **Quick Quote Desk**: instant fare calculation interface.
   - WhatsApp connect/disconnect control with QR code.

---

## 📁 Directory Structure

```
fleetlink-app/
├── server.js               # Express server (APIs, Meta webhook, static dashboard)
├── fleetlink.db             # SQLite database (auto-created tables & seed data)
├── config/
│   └── database.js          # Schema, migrations, seed data
├── services/
│   ├── whatsapp.js          # WhatsApp Web bot (whatsapp-web.js) - the primary customer/partner channel
│   ├── nlu.js                # Gemini-powered extraction: trip details, booking intent, partner availability
│   ├── distance.js          # OpenRouteService geocoding & route distance
│   ├── dispatch.js          # Own-fleet-first offer, tie-up broadcast, driver dispatch
│   ├── availability.js       # Partner availability storage + proximity ranking
│   └── tariff.js            # Outstation fare calculator
├── routes/
│   ├── api.js               # REST endpoints for the dashboard & public booking page
│   └── webhook.js           # Meta WhatsApp Cloud API webhook (optional, secondary channel - see below)
└── public/
    ├── index.html / app.js / style.css   # Admin Operations Dashboard SPA
    └── book.html / book.js               # Public customer self-service booking page
```

---

## 🚀 Quick Start Guide

### 1. Prerequisites
- Node.js (v18 or higher)
- npm

### 2. Environment Setup
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

```env
PORT=3000

# OpenRouteService (https://openrouteservice.org/dev/#/signup) - free, no card required.
# Powers auto-calculated trip distance from pickup/drop text.
ORS_API_KEY=

# Google Gemini (https://aistudio.google.com/apikey) - free tier.
# Powers the bot's understanding of free-form messages (trip details, intent, partner availability).
GEMINI_API_KEY=
GEMINI_MODEL=gemini-flash-lite-latest

# Optional - only needed if you also want the Meta Cloud API webhook path (see below).
WHATSAPP_TOKEN=
PHONE_NUMBER_ID=
WEBHOOK_VERIFY_TOKEN=fleetlink_secure_verify_token_99
META_APP_SECRET=
```

If `ORS_API_KEY` or `GEMINI_API_KEY` aren't set, those features degrade gracefully (the bot falls back to asking for distance/details directly) rather than breaking.

### 3. Run Application
```bash
npm start
```
The operations dashboard is at **`http://127.0.0.1:3000`**. Open it, click the WhatsApp status pill in the header, and scan the QR code with the phone that should run the bot - this is the **primary** connection method (see below).

---

## 📲 WhatsApp Connection: Two Channels

**Primary - WhatsApp Web (`services/whatsapp.js`, via `whatsapp-web.js`)**
This is what actually powers the bot described above: an unofficial browser automation of your personal/business WhatsApp account, linked by scanning a QR code from the dashboard (no Meta setup, no cost). Everything in this README - the conversational booking flow, own-fleet-first dispatch, availability reporting - runs through this channel.

⚠️ Because it's an unofficial automation of WhatsApp Web, it's against WhatsApp's terms for production business use at scale and carries a risk of the number being banned. It's well suited for testing and small-scale operation; for production at volume, migrate to the official channel below.

**Secondary/optional - Meta WhatsApp Cloud API (`routes/webhook.js`)**
The official, ToS-compliant path. Requires a Meta Developer account and app:
1. [Meta Developers Console](https://developers.facebook.com/) → Create App → **Other** → **Business** → add the **WhatsApp** product.
2. Configure the webhook: Callback URL `https://your-domain.com/webhook/whatsapp` (use ngrok/Cloudflare Tunnel for local testing), Verify Token matching `WEBHOOK_VERIFY_TOKEN`, subscribed to the `messages` field.

This path currently only replies with an instant quote for a structured `QUOTE Sedan Chennai to Madurai 450 2` message - it does not yet run the full Gemini conversational flow or own-fleet-first dispatch that the WhatsApp Web channel has.

---

## 💬 WhatsApp Interaction Reference

### Customers (either channel)
Text `Hi`, `Book`, or anything with genuine trip intent, then describe the trip in your own words:
> *"Chennai to Madurai this Friday for 2 days, need an SUV"*

The bot asks only for whatever's missing, then a single final message confirms everything including the auto-calculated distance:
```
📋 Here's what I've got - please check it's correct:
• Name: Ramesh Kumar
• Route: Chennai ➔ Madurai
• Date: Fri, 07 Aug 2026, 09:00 AM
• Duration: 2 Day(s)
• Vehicle: Sedan (Dzire/Etios)
• Distance: 450 KM
  (Updating that this kilometer is calculated based on the given from and to
  address. If you want to update it, add additional kilometer and then give
  us back. We will update it like that.)
• Estimated Fare: ₹7,300

Reply CONFIRM if everything looks correct, or tell me what needs to change.
```
Reply `CONFIRM` to lock it in - dispatch automatically offers it to your own fleet first, falling back to tie-up partners on decline.

### Partners (own fleet & tie-up)
- **Report availability, anytime, free text**: *"Sedan available in Chennai today"* or *"not available today"* - no fixed schedule of prompts, update whenever your situation changes.
- **Accept/decline a trip offer**: `ACCEPT FL-2026-101` / `DECLINE FL-2026-101` (or just `ACCEPT`/`DECLINE` for your most recent open offer).
- **Submit driver & vehicle details** (include the booking ref if you have multiple active trips):
  ```
  DRIVER FL-2026-101 | Senthil Kumar | +919789012345 | TN 09 CB 4567
  ```

### Admin Dashboard Escape Hatches
Every automated step also has a manual dashboard equivalent - broadcast, assign, accept/decline an own-fleet offer, dispatch driver details, edit/delete bookings/partners/rate cards, disconnect/reconnect WhatsApp - so you're never blocked if a WhatsApp exchange doesn't go as planned.

---

## 🛡️ License & Support
Designed & developed for lean outstation car rental operations in Tamil Nadu & South India. MIT License.
