const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const chrono = require('chrono-node');

let client = null;
let latestQRDataURL = null;
let isConnected = false;
let connectedUser = null;
let statusMessage = 'Initializing WhatsApp Web...';

// In-memory conversation state session store for customer booking flow.
// Key: phone number -> Value: { phase, slots: {...}, calculated_distance_km, estimated_km, pendingQuote }
const customerSessions = {};

let tariffService = null;
let dispatchService = null;
let distanceService = null;
let nluService = null;
let availabilityService = null;
let db = null;

function getDependencies() {
    if (!tariffService) tariffService = require('./tariff');
    if (!dispatchService) dispatchService = require('./dispatch');
    if (!distanceService) distanceService = require('./distance');
    if (!nluService) nluService = require('./nlu');
    if (!availabilityService) availabilityService = require('./availability');
    if (!db) db = require('../config/database');
}

function emptySlots() {
    return { customer_name: null, pickup: null, drop: null, trip_date_raw: null, trip_date_display: null, num_days: null, vehicle_type: null };
}

// Live list of vehicle_type names from the rate card catalog, so NLU extraction always
// recognizes whatever's currently bookable - including types added after this code shipped.
function getCurrentVehicleTypes() {
    return db.prepare('SELECT vehicle_type FROM rate_cards ORDER BY id ASC').all().map(r => r.vehicle_type);
}

// Parses a natural-language date phrase (via chrono-node) into ISO storage + friendly display strings.
// Returns null if the phrase couldn't be parsed as a date at all.
function parseTripDate(text) {
    const results = chrono.parse(text, new Date(), { forwardDate: true });
    if (results.length === 0) return null;

    const parsed = results[0];
    const date = parsed.date();
    const hadExplicitTime = parsed.start.isCertain('hour');
    if (!hadExplicitTime) date.setHours(9, 0, 0, 0);

    const pad = n => String(n).padStart(2, '0');
    return {
        trip_date_raw: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`,
        trip_date_display: date.toLocaleString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }),
        hadExplicitTime
    };
}

// Merges freshly-extracted NLU fields into the session's slots. Returns true if anything changed.
function applyExtractedSlots(slots, extracted) {
    let changed = false;
    if (extracted.customer_name) { slots.customer_name = extracted.customer_name; changed = true; }
    if (extracted.pickup) { slots.pickup = extracted.pickup; changed = true; }
    if (extracted.drop) { slots.drop = extracted.drop; changed = true; }
    if (extracted.num_days) { slots.num_days = extracted.num_days; changed = true; }
    if (extracted.vehicle_type) { slots.vehicle_type = extracted.vehicle_type; changed = true; }
    if (extracted.trip_date_text) {
        const parsedDate = parseTripDate(extracted.trip_date_text);
        if (parsedDate) {
            slots.trip_date_raw = parsedDate.trip_date_raw;
            slots.trip_date_display = parsedDate.trip_date_display;
            changed = true;
        }
    }
    return changed;
}

function missingSlotQuestions(slots) {
    const missing = [];
    if (!slots.customer_name) missing.push('What is your *name*?');
    if (!slots.pickup || !slots.drop) missing.push('Where are you traveling *from and to*?');
    if (!slots.trip_date_raw) missing.push('What *date* would you like to travel?');
    if (!slots.num_days) missing.push('How many *days* is the trip?');
    if (!slots.vehicle_type) missing.push(`Which *vehicle* would you like - ${getCurrentVehicleTypes().join(', ')}?`);
    return missing;
}

function summaryMessage(session, quote) {
    return `📋 *Here's what I've got - please check it's correct:*\n\n` +
        `• Name: *${session.slots.customer_name}*\n` +
        `• Route: *${session.slots.pickup} ➔ ${session.slots.drop}*\n` +
        `• Date: *${session.slots.trip_date_display}*\n` +
        `• Duration: *${session.slots.num_days} Day(s)*\n` +
        `• Vehicle: *${session.slots.vehicle_type}*\n` +
        `• Distance: *${session.estimated_km} KM*\n` +
        `_(Updating that this kilometer is calculated based on the given from and to address. If you want to update it, add additional kilometer and then give us back. We will update it like that.)_\n\n` +
        `• Estimated Fare: *₹${quote.total_amount.toLocaleString('en-IN')}*\n\n` +
        `Reply *CONFIRM* if everything looks correct, or tell me what needs to change.`;
}

// Auto-calculates distance from the route and, on success, goes straight to the single
// final confirmation summary (no separate distance-only confirmation step). Falls back
// to asking for manual KM entry only when auto-calculation itself fails.
async function finalizeTripDetails(fromPhone, session) {
    const routeDistance = await distanceService.calculateRouteDistance(session.slots.pickup, session.slots.drop);

    if (routeDistance.success) {
        session.calculated_distance_km = routeDistance.distance_km;
        session.estimated_km = routeDistance.distance_km;
        session.phase = 'confirming';

        const quote = tariffService.calculateTariff({
            vehicle_type: session.slots.vehicle_type,
            estimated_km: session.estimated_km,
            num_days: session.slots.num_days
        });
        session.pendingQuote = quote;

        await sendTextMessage(fromPhone, summaryMessage(session, quote));
    } else {
        console.warn(`[WhatsApp Bot] Distance auto-calc failed for "${session.slots.pickup}" -> "${session.slots.drop}": ${routeDistance.error}`);
        session.calculated_distance_km = null;
        session.phase = 'distance';
        await sendTextMessage(fromPhone,
            `What is the *estimated total distance* for this trip (in KM)?\n` +
            `_(We couldn't auto-calculate this route - if you're unsure, reply *0* and we'll use 300 KM/day as standard)_`);
    }
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
            // Ignore status updates, group chats, and newsletter/channel messages
            if (msg.isStatus || msg.from.includes('@g.us') || msg.from.includes('@newsletter')) return;
            const body = msg.body ? msg.body.trim() : '';
            if (!body) return;

            getDependencies();
            const fromPhone = await resolveSenderPhone(msg);
            if (!fromPhone) {
                console.warn(`[WhatsApp Inbound] Could not resolve a phone number for sender ${msg.from}. Skipping.`);
                return;
            }

            console.log(`[WhatsApp Inbound] Message from ${fromPhone}: "${body}"`);

            // A. Partner Accept Claim Check (e.g., "ACCEPT FL-2026-101" or "ACCEPT")
            // Matches both a tie-up broadcast (PARTNER_BROADCAST) and an own-fleet first-refusal offer (INTERNAL_OFFERED).
            if (body.toUpperCase().startsWith('ACCEPT') || body === '100') {
                const partner = db.prepare('SELECT * FROM partners WHERE phone LIKE ?').get(`%${fromPhone.slice(-10)}%`);
                if (partner) {
                    let booking = null;
                    if (body.toUpperCase().startsWith('ACCEPT')) {
                        const parts = body.split(' ');
                        if (parts.length >= 2) {
                            booking = db.prepare(`SELECT * FROM bookings WHERE booking_code = ? AND status IN ('PARTNER_BROADCAST', 'INTERNAL_OFFERED')`).get(parts[1]);
                        }
                    }
                    if (!booking) {
                        booking = db.prepare(`SELECT * FROM bookings WHERE status IN ('PARTNER_BROADCAST', 'INTERNAL_OFFERED') ORDER BY id DESC LIMIT 1`).get();
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

            // A1b. Partner Decline Check (e.g., "DECLINE FL-2026-101" or "DECLINE")
            // If the OWN FLEET declines a first-refusal offer, release the trip to tie-up partners.
            // If a tie-up partner declines a broadcast, just acknowledge - the others are already offered it.
            if (body.toUpperCase().startsWith('DECLINE')) {
                const partner = db.prepare('SELECT * FROM partners WHERE phone LIKE ?').get(`%${fromPhone.slice(-10)}%`);
                if (partner) {
                    const parts = body.split(' ');
                    let booking = null;
                    if (parts.length >= 2) {
                        booking = db.prepare(`SELECT * FROM bookings WHERE booking_code = ? AND status IN ('PARTNER_BROADCAST', 'INTERNAL_OFFERED')`).get(parts[1]);
                    }
                    if (!booking) {
                        booking = db.prepare(`SELECT * FROM bookings WHERE status IN ('PARTNER_BROADCAST', 'INTERNAL_OFFERED') ORDER BY id DESC LIMIT 1`).get();
                    }

                    if (!booking) {
                        await sendTextMessage(fromPhone, `⚠️ No active pending trip offer found to decline.`);
                        return;
                    }

                    if (booking.status === 'INTERNAL_OFFERED' && partner.is_internal) {
                        const broadcastResult = await dispatchService.broadcastToPartners(booking.id);
                        await sendTextMessage(fromPhone,
                            broadcastResult.success
                                ? `👍 Understood, ${partner.name}. Trip ${booking.booking_code} has been released to our tie-up partner network.`
                                : `👍 Understood, ${partner.name}. We'll arrange this trip through other means.`);
                        return;
                    }

                    await sendTextMessage(fromPhone, `👍 Thanks for letting us know, ${partner.name}. We'll offer trip ${booking.booking_code} to other partners.`);
                    return;
                }
            }

            // A2. Partner Driver & Vehicle Details Submission
            // Format: "DRIVER <Booking Ref> | <Driver Name> | <Driver Phone> | <Vehicle Number>"
            if (body.toUpperCase().startsWith('DRIVER')) {
                const partner = db.prepare('SELECT * FROM partners WHERE phone LIKE ?').get(`%${fromPhone.slice(-10)}%`);
                if (partner) {
                    const rest = body.slice('DRIVER'.length).trim();
                    const parts = rest.split('|').map(p => p.trim()).filter(Boolean);

                    if (parts.length < 4) {
                        await sendTextMessage(fromPhone,
                            `⚠️ Please send driver details in this format (include the booking reference so we assign it to the right trip):\n\n` +
                            `*DRIVER <Booking Ref> | <Driver Name> | <Driver Phone> | <Vehicle Number>*\n\n` +
                            `Example:\n*DRIVER FL-2026-101 | Senthil Kumar | +919789012345 | TN 09 CB 4567*`);
                        return;
                    }

                    const [bookingCode, driver_name, driver_phone, vehicle_number] = parts;

                    const booking = db.prepare(`
                        SELECT * FROM bookings
                        WHERE booking_code = ? AND assigned_partner_id = ? AND status = 'ASSIGNED'
                    `).get(bookingCode, partner.id);

                    if (!booking) {
                        await sendTextMessage(fromPhone, `⚠️ No active assigned trip found with reference *${bookingCode}* for you. Please check the booking reference and try again.`);
                        return;
                    }

                    await dispatchService.dispatchTripVoucherToCustomer(booking.id, { driver_name, driver_phone, vehicle_number });
                    await sendTextMessage(fromPhone, `✅ Thanks! Driver & vehicle details for ${booking.booking_code} have been sent to the customer.`);
                    return;
                }
            }

            // A3. Partner Availability Update - any other message from a known partner
            // number is treated as a free-text availability report (e.g. "Sedan available
            // in Chennai today", "not available today"). No scheduled prompts - partners
            // update whenever their situation changes.
            const reportingPartner = db.prepare('SELECT * FROM partners WHERE phone LIKE ?').get(`%${fromPhone.slice(-10)}%`);
            if (reportingPartner) {
                const avail = await nluService.extractAvailabilityUpdate(body, getCurrentVehicleTypes());

                if (avail.is_available === null && !avail.vehicle_type && !avail.location) {
                    await sendTextMessage(fromPhone,
                        `👋 Hi ${reportingPartner.name}! To update your availability, just tell us, e.g.:\n` +
                        `_"Sedan available in Chennai today"_ or _"not available today"_.`);
                    return;
                }

                const record = await availabilityService.reportAvailability(reportingPartner.id, avail);

                if (record.is_available) {
                    const details = [
                        record.vehicle_type ? `Vehicle: *${record.vehicle_type}*` : null,
                        record.vehicle_number ? `Reg: *${record.vehicle_number}*` : null,
                        record.location ? `Location: *${record.location}*` : null
                    ].filter(Boolean).join(' | ');
                    await sendTextMessage(fromPhone,
                        `✅ Thanks ${reportingPartner.name}! Marked you *available*${details ? ` - ${details}` : ''}.\n` +
                        `We'll prioritize you for nearby trips. Reply anytime to update.`);
                } else {
                    await sendTextMessage(fromPhone,
                        `✅ Thanks ${reportingPartner.name}! Marked you *unavailable* - we won't send trip offers until you update us again.`);
                }
                return;
            }

            // B. Conversational Customer Booking Assistant (open-ended, slot-filling flow)
            let session = customerSessions[fromPhone];

            // Only start (or reset) the booking flow on an explicit greeting/booking keyword, or
            // - when there's no active session and no keyword matched - when an AI intent check
            // confirms this looks like a genuine booking inquiry. This matters because another
            // automated system (an away-message bot, a delivery-notification bot, etc.) replying
            // to us must NOT be met with a fresh round of prompts; defaulting to silence when
            // intent is unclear avoids an endless bot-to-bot message loop.
            // "trip"/"cab" only count as trigger keywords when there's no session in progress,
            // since a genuine mid-flow answer (e.g. a correction) could otherwise contain them too.
            const lowerBody = body.toLowerCase();
            const isExplicitTrigger = lowerBody === 'hi' || lowerBody === 'hello' || lowerBody === 'hey' ||
                lowerBody === 'reset' || lowerBody.includes('book') ||
                (!session && (lowerBody.includes('trip') || lowerBody.includes('cab')));

            let isBookingTrigger = isExplicitTrigger;
            if (!isBookingTrigger && !session) {
                isBookingTrigger = await nluService.detectBookingIntent(body);
            }

            if (isBookingTrigger) {
                // If we already know this customer's name from a prior booking, pre-fill it
                const priorBooking = db.prepare(`
                    SELECT customer_name FROM bookings
                    WHERE customer_phone = ? AND customer_name IS NOT NULL AND customer_name != ''
                          AND customer_name NOT LIKE 'WhatsApp Customer (%'
                    ORDER BY id DESC LIMIT 1
                `).get(fromPhone);
                const knownName = priorBooking?.customer_name || null;

                const newSession = { phase: 'collecting', slots: { ...emptySlots(), customer_name: knownName }, noProgressCount: 0 };
                customerSessions[fromPhone] = newSession;

                // Try extracting from this same triggering message right away, so a customer who
                // already stated their trip in full doesn't get asked to repeat themselves.
                const extracted = await nluService.extractTripDetails(body, newSession.slots, getCurrentVehicleTypes());
                const gotSomething = applyExtractedSlots(newSession.slots, extracted);

                const intro = knownName
                    ? `👋 *Welcome back to Flying Eagle, ${knownName}!* 🚕`
                    : `👋 *Welcome to Flying Eagle Outstation Car Rentals!* 🚕`;

                if (!gotSomething) {
                    await sendTextMessage(fromPhone,
                        `${intro}\n\n` +
                        `Tell me about your trip - where you're headed, when, how many days, and which vehicle you'd like. Just describe it in your own words!\n` +
                        `_(e.g. "Chennai to Madurai this Friday for 2 days, need an SUV")_`);
                    return;
                }

                const missing = missingSlotQuestions(newSession.slots);
                if (missing.length > 0) {
                    const questionsText = missing.map(q => `➤ ${q}`).join('\n');
                    await sendTextMessage(fromPhone, `${intro}\n\nGot it, thanks! Just need a bit more info:\n\n${questionsText}`);
                    return;
                }

                await sendTextMessage(fromPhone, intro);
                await finalizeTripDetails(fromPhone, newSession);
                return;
            }

            // No active session and no detected booking intent - do NOT start the automation
            // or send anything, EXCEPT "CONFIRM" as a safety net (in case a booking somehow
            // didn't get dispatched). Staying silent otherwise avoids replying to spam/other bots.
            if (!session) {
                if (body.toLowerCase() === 'confirm') {
                    const pendingBooking = db.prepare(`
                        SELECT * FROM bookings
                        WHERE customer_phone = ? AND status = 'PENDING'
                        ORDER BY id DESC LIMIT 1
                    `).get(fromPhone);

                    if (!pendingBooking) return; // nothing to confirm - stay silent rather than nudge

                    const broadcastResult = await dispatchService.offerToOwnFleet(pendingBooking.id);
                    if (broadcastResult.success) {
                        await sendTextMessage(fromPhone,
                            `✅ Thanks! We've notified our fleet for *${pendingBooking.booking_code}*. You'll get a confirmation the moment a vehicle is locked in.`);
                    } else {
                        await sendTextMessage(fromPhone,
                            `✅ Got it! Your booking *${pendingBooking.booking_code}* is confirmed. We're arranging a vehicle and will follow up shortly.`);
                    }
                    return;
                }

                // No session, no intent detected - deliberately silent (see comment above).
                return;
            }

            // Phase: collecting - extract whatever we can from the customer's message, and
            // ask only for whatever's still missing (never re-asking what we already have).
            if (session.phase === 'collecting') {
                const extracted = await nluService.extractTripDetails(body, session.slots, getCurrentVehicleTypes());

                // An infrastructure failure (Gemini unreachable/timed out) is not the
                // customer's fault - don't count it against the no-progress loop-guard,
                // and be honest that we couldn't read their message rather than implying
                // we understood it and just need more info.
                if (extracted._apiError) {
                    await sendTextMessage(fromPhone,
                        `⚠️ Sorry, we're having trouble processing messages right now. Please resend your last message in a moment.`);
                    return;
                }

                const gotSomething = applyExtractedSlots(session.slots, extracted);

                const missing = missingSlotQuestions(session.slots);
                if (missing.length > 0) {
                    // Loop-guard: if replies keep arriving with nothing usable extracted, this is
                    // very likely another automated system, not a real customer - stop responding
                    // instead of nudging forever back and forth.
                    if (gotSomething) {
                        session.noProgressCount = 0;
                    } else {
                        session.noProgressCount = (session.noProgressCount || 0) + 1;
                        if (session.noProgressCount >= 2) {
                            console.warn(`[WhatsApp Bot] No progress from ${fromPhone} after repeated prompts - going silent to avoid a bot loop.`);
                            delete customerSessions[fromPhone];
                            return;
                        }
                    }
                    const questionsText = missing.map(q => `➤ ${q}`).join('\n');
                    await sendTextMessage(fromPhone, `Got it, thanks! Just need a bit more info:\n\n${questionsText}`);
                    return;
                }

                await finalizeTripDetails(fromPhone, session);
                return;
            }

            // Phase: distance - manual KM entry, only reached when auto-calculation of the
            // route itself failed (no separate confirmation step when it succeeds - that's
            // now folded into the single final confirmation below).
            if (session.phase === 'distance') {
                const kmInput = body.trim();
                if (!/^\d{1,5}$/.test(kmInput)) {
                    await abortBookingSession(fromPhone,
                        `That doesn't look like a valid distance. Please reply with just a number in KM, or *0* if unsure.`);
                    return;
                }
                let dist = parseInt(kmInput, 10);
                if (dist === 0) dist = 300 * session.slots.num_days;

                session.estimated_km = dist;
                session.phase = 'confirming';

                const quote = tariffService.calculateTariff({
                    vehicle_type: session.slots.vehicle_type,
                    estimated_km: dist,
                    num_days: session.slots.num_days
                });
                session.pendingQuote = quote;

                await sendTextMessage(fromPhone, summaryMessage(session, quote));
                return;
            }

            // Phase: confirming - the single final check of everything we understood,
            // including the auto-calculated distance. A plain CONFIRM locks the booking and
            // notifies partners; a bare number is treated as extra KM to add to the
            // auto-calculated base; anything else is treated as a correction, re-extracted
            // and merged before re-showing the summary.
            if (session.phase === 'confirming') {
                if (body.trim().toLowerCase() === 'confirm') {
                    const quote = session.pendingQuote;
                    const bookingCode = `FL-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`;

                    const stmt = db.prepare(`
                        INSERT INTO bookings (
                            booking_code, customer_name, customer_phone, pickup_location, drop_location,
                            trip_start_date, trip_end_date, num_days, estimated_km, vehicle_type,
                            calculated_amount, status, notes
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'Created via WhatsApp Bot')
                    `);
                    stmt.run(
                        bookingCode,
                        session.slots.customer_name,
                        fromPhone,
                        session.slots.pickup,
                        session.slots.drop,
                        session.slots.trip_date_raw,
                        session.slots.trip_date_raw,
                        session.slots.num_days,
                        session.estimated_km,
                        session.slots.vehicle_type,
                        quote.total_amount
                    );

                    const booking = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(bookingCode);
                    const broadcastResult = await dispatchService.offerToOwnFleet(booking.id);

                    const partnerNote = broadcastResult.success
                        ? `✅ We've notified our fleet - you'll get a confirmation the moment a vehicle is locked in, followed by driver & vehicle details closer to departure.`
                        : `✅ We're arranging a vehicle for you and will follow up shortly with driver & vehicle details.`;

                    const finalMsg =
                        `🎉 *BOOKING CONFIRMED!* 🚕\n` +
                        `-----------------------------------\n` +
                        `• Booking Ref: *${bookingCode}*\n` +
                        `• Customer: *${session.slots.customer_name}*\n` +
                        `• Route: *${session.slots.pickup} ➔ ${session.slots.drop}*\n` +
                        `• Trip Date: *${session.slots.trip_date_display}*\n` +
                        `• Vehicle: *${session.slots.vehicle_type}*\n` +
                        `• Duration: *${session.slots.num_days} Day(s)* (${session.estimated_km} KM)\n\n` +
                        `*TOTAL ESTIMATED FARE: ₹${quote.total_amount.toLocaleString('en-IN')}*\n` +
                        `_(Excludes Toll, Parking & State Permits)_\n\n` +
                        `${partnerNote}\n\n` +
                        `Reply *HI* to start a new trip quote.`;

                    await sendTextMessage(fromPhone, finalMsg);
                    delete customerSessions[fromPhone];
                    console.log(`[WhatsApp Bot] Booking ${bookingCode} auto-created for ${session.slots.customer_name} (${fromPhone})`);
                    return;
                }

                // A bare number = extra KM to add to the auto-calculated base distance
                if (session.calculated_distance_km != null && /^\d{1,5}$/.test(body.trim())) {
                    session.estimated_km = session.calculated_distance_km + parseInt(body.trim(), 10);

                    const updatedQuote = tariffService.calculateTariff({
                        vehicle_type: session.slots.vehicle_type,
                        estimated_km: session.estimated_km,
                        num_days: session.slots.num_days
                    });
                    session.pendingQuote = updatedQuote;
                    await sendTextMessage(fromPhone, `Updated! ${summaryMessage(session, updatedQuote)}`);
                    return;
                }

                // Not a plain confirm or extra-KM number - treat as a correction
                const extracted = await nluService.extractTripDetails(body, session.slots, getCurrentVehicleTypes());

                if (extracted._apiError) {
                    await sendTextMessage(fromPhone,
                        `⚠️ Sorry, we're having trouble processing messages right now. Please resend your last message in a moment.`);
                    return;
                }

                const routeChanged = (extracted.pickup && extracted.pickup !== session.slots.pickup) ||
                    (extracted.drop && extracted.drop !== session.slots.drop);
                const changed = applyExtractedSlots(session.slots, extracted);

                if (!changed) {
                    await abortBookingSession(fromPhone,
                        `I didn't catch a correction there. Please reply *CONFIRM* if everything's correct, or clearly tell me what to change (e.g. "change vehicle to SUV").`);
                    return;
                }

                if (routeChanged) {
                    // Route changed - recalculate distance and go straight back to the single
                    // combined confirmation (falls back to asking for manual KM only if the
                    // new route can't be auto-calculated).
                    const routeDistance = await distanceService.calculateRouteDistance(session.slots.pickup, session.slots.drop);
                    if (routeDistance.success) {
                        session.calculated_distance_km = routeDistance.distance_km;
                        session.estimated_km = routeDistance.distance_km;
                        session.phase = 'confirming';

                        const quote = tariffService.calculateTariff({
                            vehicle_type: session.slots.vehicle_type,
                            estimated_km: session.estimated_km,
                            num_days: session.slots.num_days
                        });
                        session.pendingQuote = quote;
                        await sendTextMessage(fromPhone, `Updated! ${summaryMessage(session, quote)}`);
                    } else {
                        session.calculated_distance_km = null;
                        session.phase = 'distance';
                        await sendTextMessage(fromPhone,
                            `Updated! What is the *estimated total distance* for this new route (in KM)?`);
                    }
                    return;
                }

                // Recompute the fare with whatever changed and re-show the summary
                const quote = tariffService.calculateTariff({
                    vehicle_type: session.slots.vehicle_type,
                    estimated_km: session.estimated_km,
                    num_days: session.slots.num_days
                });
                session.pendingQuote = quote;
                await sendTextMessage(fromPhone, `Updated! ${summaryMessage(session, quote)}`);
                return;
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

// Logs out the current WhatsApp Web session (unlinks the device, same as removing it from
// WhatsApp's own Linked Devices list). The client's 'disconnected' handler automatically
// re-initializes afterward, generating a fresh QR code for reconnecting.
async function disconnectClient() {
    if (!client) {
        return { success: false, error: 'WhatsApp client is not initialized.' };
    }
    if (!isConnected) {
        return { success: false, error: 'WhatsApp is not currently connected.' };
    }

    try {
        await client.logout();
        return { success: true };
    } catch (err) {
        console.error('[WhatsApp Web] Logout error, forcing a full client reset instead:', err.message);
        // The underlying browser session can end up in a broken state (e.g. a detached
        // Puppeteer frame) where a graceful logout can't run at all. When that happens,
        // don't just report failure and leave the status stuck showing "Connected" -
        // force a teardown and reconnect from scratch so the UI reflects reality and a
        // fresh QR code becomes available.
        isConnected = false;
        connectedUser = null;
        statusMessage = 'Disconnected. Re-initializing...';
        try {
            await client.destroy();
        } catch (destroyErr) {
            console.error('[WhatsApp Web] Error destroying broken client:', destroyErr.message);
        }
        client = null;
        initWhatsAppClient();
        return { success: true, forced: true };
    }
}

// Stops an in-progress booking conversation when the customer's reply doesn't
// match what that step expected, instead of guessing/defaulting silently.
async function abortBookingSession(fromPhone, reasonMsg) {
    delete customerSessions[fromPhone];
    await sendTextMessage(fromPhone,
        `⚠️ ${reasonMsg}\n\n` +
        `Your booking request has been stopped. Reply *HI* or *BOOK TRIP* whenever you'd like to start again.`);
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
    // Already a full WhatsApp JID (e.g. "<id>@lid" or "<number>@c.us") - pass through as-is.
    // Reconstructing a "@c.us" address from a bare number doesn't work for contacts
    // WhatsApp is only willing to address via their privacy "@lid" identity.
    if (phone.includes('@')) return phone;

    let cleaned = phone.replace(/[^0-9]/g, '');
    if (cleaned.length === 10) cleaned = '91' + cleaned;
    return `${cleaned}@c.us`;
}

// Resolves a stable identifier to reply to this sender with. Contacts not saved
// in our contacts arrive as a privacy-preserving "@lid" JID instead of a real
// "<phone>@c.us" - WhatsApp only allows replying to those via that exact JID
// (reconstructing a phone-number-style address fails with "No LID for user"),
// so we keep the raw JID for them rather than resolving to a phone number.
async function resolveSenderPhone(msg) {
    if (msg.from.endsWith('@c.us')) {
        return '+' + msg.from.replace('@c.us', '');
    }
    return msg.from;
}

initWhatsAppClient();

module.exports = {
    getStatus,
    disconnectClient,
    sendTextMessage,
    sendInteractiveButtons
};
