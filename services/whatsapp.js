const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');

let client = null;
let latestQRDataURL = null;
let isConnected = false;
let connectedUser = null;
let statusMessage = 'Initializing WhatsApp Web...';

// In-memory conversation state session store for customer booking flow
// Key: phone number -> Value: { step, pickup, drop, num_days, vehicle_type, estimated_km }
const customerSessions = {};

let tariffService = null;
let dispatchService = null;
let db = null;

function getDependencies() {
    if (!tariffService) tariffService = require('./tariff');
    if (!dispatchService) dispatchService = require('./dispatch');
    if (!db) db = require('../config/database');
}

function initWhatsAppClient() {
    console.log('[WhatsApp Web] Launching headless WhatsApp Web instance...');

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(__dirname, '..', '.wwebjs_auth')
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', async (qr) => {
        console.log('[WhatsApp Web] New QR Code generated.');
        try {
            latestQRDataURL = await QRCode.toDataURL(qr);
            isConnected = false;
            statusMessage = 'Scan QR Code from Admin Dashboard to connect WhatsApp.';
        } catch (err) {
            console.error('[WhatsApp Web] QR Code generation error:', err);
        }
    });

    client.on('ready', () => {
        console.log('[WhatsApp Web] Client is READY and CONNECTED!');
        isConnected = true;
        latestQRDataURL = null;
        connectedUser = client.info ? client.info.wid.user : 'Connected';
        statusMessage = `Connected as +${connectedUser}`;
    });

    client.on('authenticated', () => {
        statusMessage = 'Authenticated. Syncing chats...';
    });

    client.on('auth_failure', (msg) => {
        console.error('[WhatsApp Web] Auth failure:', msg);
        isConnected = false;
        statusMessage = 'Authentication failed. Please refresh QR code.';
    });

    client.on('disconnected', (reason) => {
        console.warn('[WhatsApp Web] Client disconnected:', reason);
        isConnected = false;
        connectedUser = null;
        statusMessage = 'Disconnected. Re-initializing...';
        client.initialize();
    });

    // Inbound Messages Listener
    client.on('message', async (msg) => {
        try {
            // Ignore status updates, group chats, newsletter/channel messages, and empty messages
            if (msg.isStatus || msg.from.includes('@g.us') || msg.from.includes('@lid') || msg.from.includes('@newsletter')) return;
            const body = msg.body ? msg.body.trim() : '';
            if (!body) return;

            getDependencies();
            const fromJid = msg.from;
            const fromPhone = '+' + fromJid.replace('@c.us', '');

            console.log(`[WhatsApp Inbound] Message from ${fromPhone}: "${body}"`);

            // A. Partner Accept Claim Check (e.g., "ACCEPT FL-2026-101" or "ACCEPT")
            if (body.toUpperCase().startsWith('ACCEPT') || body === '100') {
                const partner = db.prepare('SELECT * FROM partners WHERE phone LIKE ?').get(`%${fromPhone.slice(-10)}%`);
                if (partner) {
                    let booking = null;
                    if (body.toUpperCase().startsWith('ACCEPT')) {
                        const parts = body.split(' ');
                        if (parts.length >= 2) {
                            booking = db.prepare('SELECT * FROM bookings WHERE booking_code = ? AND status = "PARTNER_BROADCAST"').get(parts[1]);
                        }
                    }
                    if (!booking) {
                        booking = db.prepare('SELECT * FROM bookings WHERE status = "PARTNER_BROADCAST" ORDER BY id DESC LIMIT 1').get();
                    }

                    if (booking) {
                        await dispatchService.assignPartnerToBooking(booking.id, partner.id);
                        await sendTextMessage(fromPhone, `✅ Thank you ${partner.name}! Booking ${booking.booking_code} is assigned to you.`);
                        return;
                    } else {
                        await sendTextMessage(fromPhone, `⚠️ Sorry! No active pending trip offers found for claim.`);
                        return;
                    }
                }
            }

            // B. Conversational Customer Booking Assistant (6-step interactive flow)
            let session = customerSessions[fromPhone];

            // Reset or start new booking session
            if (!session || body.toLowerCase() === 'hi' || body.toLowerCase() === 'hello' || body.toLowerCase() === 'reset' || body.toLowerCase().includes('book') || body.toLowerCase().includes('new trip')) {
                customerSessions[fromPhone] = { step: 1 };
                const greeting = 
                    `👋 *Welcome to FleetLink Outstation Car Rentals!* 🚕\n\n` +
                    `I'll help you get an instant trip quote and reserve a vehicle.\n\n` +
                    `📝 *Step 1 of 6:*\n` +
                    `What is your *Name*?\n` +
                    `_(Example: Ramesh Kumar)_`;
                await sendTextMessage(fromPhone, greeting);
                return;
            }

            // Step 1: Collect Customer Name
            if (session.step === 1) {
                session.customer_name = body;
                session.step = 2;

                const q2 = 
                    `Thanks *${session.customer_name}*! 🙏\n\n` +
                    `📍 *Step 2 of 6:*\n` +
                    `Where is your *Pickup & Drop Location*?\n` +
                    `_(Example: Chennai Airport to Madurai)_`;
                await sendTextMessage(fromPhone, q2);
                return;
            }

            // Step 2: Handle Pickup & Drop Response
            if (session.step === 2) {
                const locations = body.split(/\bto\b|-|➔|→/i);
                session.pickup = locations[0] ? locations[0].trim() : body;
                session.drop = locations[1] ? locations[1].trim() : 'Outstation Return';
                session.step = 3;

                const q3 = 
                    `📍 *${session.pickup}* ➔ *${session.drop}*\n\n` +
                    `📅 *Step 3 of 6:*\n` +
                    `What is your *Trip Date & Time*?\n` +
                    `_(Example: 10 Aug 6 AM  or  2026-08-10 06:00)_`;
                await sendTextMessage(fromPhone, q3);
                return;
            }

            // Step 3: Handle Trip Date
            if (session.step === 3) {
                session.trip_date_raw = body;
                session.step = 4;

                const q4 = 
                    `📅 Trip Date: *${body}*\n\n` +
                    `🗓️ *Step 4 of 6:*\n` +
                    `How many *days* is your trip?\n` +
                    `_(Reply with a number, e.g., 2)_`;
                await sendTextMessage(fromPhone, q4);
                return;
            }

            // Step 4: Handle Number of Days
            if (session.step === 4) {
                const days = parseInt(body, 10) || 1;
                session.num_days = Math.max(1, days);
                session.step = 5;

                const q5 = 
                    `Got it! *${session.num_days} Day(s)*.\n\n` +
                    `🚕 *Step 5 of 6:*\n` +
                    `Which *vehicle category* do you prefer?\n\n` +
                    `1️⃣ *Sedan (Dzire/Etios)* - ₹13/KM\n` +
                    `2️⃣ *SUV (Ertiga)* - ₹17/KM\n` +
                    `3️⃣ *Premium SUV (Innova Crysta)* - ₹21/KM\n` +
                    `4️⃣ *Tempo Traveller (12 Seater)* - ₹26/KM\n\n` +
                    `_(Reply 1, 2, 3, or 4)_`;
                await sendTextMessage(fromPhone, q5);
                return;
            }

            // Step 5: Handle Vehicle Selection
            if (session.step === 5) {
                let vehicleType = 'Sedan (Dzire/Etios)';
                if (body === '2' || body.toLowerCase().includes('suv') || body.toLowerCase().includes('ertiga')) vehicleType = 'SUV (Ertiga)';
                if (body === '3' || body.toLowerCase().includes('innova') || body.toLowerCase().includes('crysta')) vehicleType = 'Premium SUV (Innova Crysta)';
                if (body === '4' || body.toLowerCase().includes('tempo') || body.toLowerCase().includes('traveller')) vehicleType = 'Tempo Traveller (12 Seater)';

                session.vehicle_type = vehicleType;
                session.step = 6;

                const q6 = 
                    `Selected: *${vehicleType}* ✅\n\n` +
                    `🛣️ *Step 6 of 6:*\n` +
                    `What is the *Estimated Total Distance (KM)*?\n` +
                    `_(If you're unsure, reply *0* and we'll use 300 KM/day as standard)_`;
                await sendTextMessage(fromPhone, q6);
                return;
            }

            // Step 6: Handle KM & Generate Final Quote + Auto-Create Booking
            if (session.step === 6) {
                let dist = parseInt(body, 10) || 0;
                if (dist === 0) dist = 300 * session.num_days;

                session.estimated_km = dist;

                // Calculate Tariff
                const quote = tariffService.calculateTariff({
                    vehicle_type: session.vehicle_type,
                    estimated_km: dist,
                    num_days: session.num_days
                });

                // Auto-create Booking in DB
                const bookingCode = `FL-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`;
                const tripDate = session.trip_date_raw || new Date(Date.now() + 86400000).toISOString().slice(0, 16);

                const stmt = db.prepare(`
                    INSERT INTO bookings (
                        booking_code, customer_name, customer_phone, pickup_location, drop_location,
                        trip_start_date, trip_end_date, num_days, estimated_km, vehicle_type,
                        calculated_amount, status, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'Created via WhatsApp Bot')
                `);

                stmt.run(
                    bookingCode,
                    session.customer_name || `WhatsApp Customer (${fromPhone.slice(-4)})`,
                    fromPhone,
                    session.pickup,
                    session.drop,
                    tripDate,
                    tripDate,
                    session.num_days,
                    dist,
                    session.vehicle_type,
                    quote.total_amount
                );

                // Send complete quotation with summary
                const finalMsg = 
                    `🎉 *YOUR FLEETLINK TRIP QUOTATION* 🚕\n` +
                    `-----------------------------------\n` +
                    `• Booking Ref: *${bookingCode}*\n` +
                    `• Customer: *${session.customer_name}*\n` +
                    `• Route: *${session.pickup} ➔ ${session.drop}*\n` +
                    `• Trip Date: *${session.trip_date_raw}*\n` +
                    `• Vehicle: *${session.vehicle_type}*\n` +
                    `• Duration: *${session.num_days} Day(s)* (${dist} KM)\n\n` +
                    `💰 *Fare Breakdown:*\n` +
                    `  • Base Fare (${quote.billable_km} KM × ₹${quote.per_km_rate}): ₹${quote.km_cost.toLocaleString('en-IN')}\n` +
                    `  • Driver Batta (${session.num_days} day × ₹${quote.driver_batta_per_day}): ₹${quote.total_driver_batta.toLocaleString('en-IN')}\n` +
                    `-----------------------------------\n` +
                    `*TOTAL ESTIMATED FARE: ₹${quote.total_amount.toLocaleString('en-IN')}*\n` +
                    `_(Excludes Toll, Parking & State Permits)_\n\n` +
                    `✅ Our team has received your booking! We'll confirm vehicle availability shortly.\n\n` +
                    `Reply *CONFIRM* to lock this booking.\n` +
                    `Reply *HI* to start a new trip quote.`;

                await sendTextMessage(fromPhone, finalMsg);

                // Clear session
                delete customerSessions[fromPhone];
                console.log(`[WhatsApp Bot] Booking ${bookingCode} auto-created for ${session.customer_name} (${fromPhone})`);
                return;
            }

            // Customer confirmation reply
            if (body.toLowerCase() === 'confirm') {
                await sendTextMessage(fromPhone, 
                    `✅ *Booking Confirmed!* 🎉\n\n` +
                    `Thank you! Your booking is locked with FleetLink.\n` +
                    `Driver & Vehicle details will be shared *2-4 hours* before your departure.\n\n` +
                    `For any changes, reply here or call us directly. Have a safe trip! 🚕`);
                return;
            }

            // Fallback for unrecognized messages
            if (!session) {
                await sendTextMessage(fromPhone,
                    `👋 Hi there! Reply *HI* or *BOOK* to start your outstation trip booking with FleetLink. 🚕`);
            }

        } catch (err) {
            console.error('[WhatsApp Customer Bot Error]', err);
        }
    });

    client.initialize();
}

function getStatus() {
    return {
        isConnected,
        statusMessage,
        connectedUser,
        qrDataURL: latestQRDataURL
    };
}

async function sendTextMessage(toPhone, text) {
    const formattedJid = formatPhoneToJid(toPhone);
    console.log(`[WhatsApp Web Outbound] Sending to ${formattedJid}:\n${text}`);

    if (client && isConnected) {
        try {
            await client.sendMessage(formattedJid, text);
            return { success: true, mode: 'live_web' };
        } catch (err) {
            console.error('[WhatsApp Web Send Error]', err);
            return { success: false, error: err.message };
        }
    } else {
        console.warn('[WhatsApp Web Warning] Client not connected. Logging mock payload.');
        return { success: true, mode: 'mock' };
    }
}

async function sendInteractiveButtons(toPhone, bodyText, buttons) {
    const optionsText = buttons.map((btn, index) => `${index + 1}️⃣ ${btn.title}`).join('\n');
    const fullText = `${bodyText}\n\n*Reply with option number:*\n${optionsText}`;
    return sendTextMessage(toPhone, fullText);
}

function formatPhoneToJid(phone) {
    let cleaned = phone.replace(/[^0-9]/g, '');
    if (cleaned.length === 10) cleaned = '91' + cleaned;
    return `${cleaned}@c.us`;
}

initWhatsAppClient();

module.exports = {
    getStatus,
    sendTextMessage,
    sendInteractiveButtons
};
