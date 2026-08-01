# 🚕 Flying Eagle - WhatsApp B2B Outstation Operations Engine & Operations Dashboard

A production-ready, lightweight B2B fleet booking and automated dispatch platform for outstation car rentals. Built using **Meta WhatsApp Cloud API**, **Node.js (Express)**, **SQLite / PostgreSQL**, and a modern **Single-Page Operations Dashboard**.

---

## 🌟 Key Features

1. **WhatsApp Instant Tariff Engine**:
   - Auto-calculates outstation trip fares using standard rate cards:
     `Total Fare = MAX(Actual KM, Min KM/Day * Days) * Per-KM Rate + (Driver Batta * Days) + Night Charge`
2. **Automated Tie-up Partner Broadcast**:
   - If internal fleet is unavailable, sends interactive WhatsApp messages with **ACCEPT TRIP** / **DECLINE** buttons to 5-10 tie-up travel partners.
   - First partner to reply/click accept locks the booking assignment.
3. **Automated Pre-Trip Driver Dispatch (T-4 Hours)**:
   - Requests vehicle reg number and driver contact from assigned partner.
   - Automatically formats and dispatches a digital WhatsApp Trip Card to the customer 2–4 hours prior to departure.
4. **Single-Page Operations Dashboard**:
   - **Live Operations Board**: Track pending, broadcasted, assigned, and in-progress trips.
   - **Rate Card Manager**: Editable rates per vehicle class (Sedan, SUV, Innova, Tempo).
   - **Quick Quote Desk**: Instant fare calculation interface.
   - **Fleet & Partner Directory**: Manage partner contacts and vehicle capabilities.

---

## 📁 Directory Structure

```
fleetlink-app/
├── server.js               # Express server (APIs, Meta Webhooks, Static Dashboard)
├── fleetlink.db            # SQLite database with auto-created tables & seed data
├── config/
│   └── database.js         # Database configuration & schema migrations
├── services/
│   ├── tariff.js           # Outstation fare calculator
│   ├── whatsapp.js         # Meta WhatsApp Cloud API wrapper (Interactive buttons & text)
│   └── dispatch.js         # Partner broadcast & driver assignment engine
├── routes/
│   ├── webhook.js          # Meta WhatsApp GET verification & POST event receiver
│   └── api.js              # REST endpoints for Operations Dashboard
└── public/
    ├── index.html          # Operations Dashboard SPA UI
    ├── style.css           # Glassmorphism dark mode stylesheet
    └── app.js              # Single-page application logic
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

Set your Meta WhatsApp credentials in `.env`:
```env
PORT=3000
WHATSAPP_TOKEN=your_meta_system_user_token
PHONE_NUMBER_ID=your_whatsapp_phone_number_id
WEBHOOK_VERIFY_TOKEN=fleetlink_secure_verify_token_99
META_APP_SECRET=your_meta_app_secret
```

*(Note: If live Meta credentials are not set, the app automatically operates in **Mock Mode**, logging all outbound WhatsApp payloads cleanly to the console for testing!)*

### 3. Run Application
```bash
# Start server
npm start
```
The operations dashboard will be live at: **`http://127.0.0.1:3000`**

---

## 📲 Meta WhatsApp Cloud API Integration Setup

1. **Meta Developer Portal Setup**:
   - Go to [Meta Developers Console](https://developers.facebook.com/) -> Create App -> Select **Other** -> **Business**.
   - Add **WhatsApp** product to your app.
2. **Configure Webhook**:
   - **Callback URL**: `https://your-domain.com/webhook/whatsapp` (or use Ngrok/Cloudflare tunnel during testing: `https://xxxx.ngrok-free.app/webhook/whatsapp`).
   - **Verify Token**: Must match `WEBHOOK_VERIFY_TOKEN` in your `.env` (default: `fleetlink_secure_verify_token_99`).
   - **Webhook Fields**: Subscribe to `messages`.

---

## 💬 WhatsApp Customer & Partner Interaction Rules

### Customer Inbound Format
Customers can text **`Hi`** or send structured quotes:
> **`QUOTE Sedan Chennai to Madurai 450 2`**

System auto-replies with:
```
*Flying Eagle Trip Quote* 🚕
• Vehicle: Sedan (Dzire/Etios)
• Estimated Distance: 450 KM (Min Billed: 500 KM @ ₹13/KM)
• Duration: 2 Day(s)
• Base Fare: ₹6,500
• Driver Batta: ₹800 (₹400/day)
-----------------------------------
*Estimated Total: ₹7,300*
_(Excludes Toll, Parking & State Permitting Charges)_
```

### Partner WhatsApp Interactive Buttons
When you click **"Broadcast to Partners"** on the dashboard, partners receive interactive buttons:
```
🚨 NEW OUTSTATION TRIP OFFER 🚕
• Booking Ref: FL-2026-101
• Vehicle: SUV (Ertiga)
• Pickup: Chennai Airport ➔ Drop: Trichy
-----------------------------------
[ ✅ ACCEPT TRIP ]    [ ❌ PASS ]
```

---

## 🛡️ License & Support
Designed & developed for lean outstation car rental operations in Tamil Nadu & South India. MIT License.
