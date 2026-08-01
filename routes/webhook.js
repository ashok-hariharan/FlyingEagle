const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../config/database');
const tariffService = require('../services/tariff');
const whatsappService = require('../services/whatsapp');
const dispatchService = require('../services/dispatch');

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'fleetlink_secure_verify_token_99';
const META_APP_SECRET = process.env.META_APP_SECRET || '';

/**
 * 1. Meta Webhook Verification Endpoint (GET)
 */
router.get('/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('[Meta Webhook] GET Verification Successful!');
            return res.status(200).send(challenge);
        } else {
            console.error('[Meta Webhook] Verification token mismatch.');
            return res.sendStatus(403);
        }
    }
    return res.sendStatus(400);
});

/**
 * 2. Meta Webhook Event Handler Endpoint (POST)
 */
router.post('/whatsapp', async (req, res) => {
    // 2a. Security HMAC check if APP_SECRET exists
    if (META_APP_SECRET && req.headers['x-hub-signature-256']) {
        const signature = req.headers['x-hub-signature-256'];
        const expectedSignature = 'sha256=' + crypto
            .createHmac('sha256', META_APP_SECRET)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (signature !== expectedSignature) {
            console.error('[Meta Webhook Security Failure] Invalid X-Hub-Signature-256');
            return res.status(401).send('Invalid Signature');
        }
    }

    // Always acknowledge Meta instantly with 200 OK
    res.status(200).send('EVENT_RECEIVED');

    try {
        const body = req.body;
        if (!body.object || !body.entry || !body.entry[0].changes) return;

        const change = body.entry[0].changes[0].value;
        if (!change.messages || change.messages.length === 0) return;

        const message = change.messages[0];
        const fromPhone = message.from; // Sender WhatsApp Phone Number

        // Handle Interactive Button Reply (e.g., Partner Accept Trip)
        if (message.type === 'interactive' && message.interactive.button_reply) {
            const replyId = message.interactive.button_reply.id; // e.g. "ACCEPT_FL-2026-101_2"
            console.log(`[Webhook Event] Interactive Button Clicked: ${replyId} from ${fromPhone}`);

            if (replyId.startsWith('ACCEPT_')) {
                const parts = replyId.split('_'); // ['ACCEPT', 'FL-2026-101', '2']
                const bookingCode = parts[1];
                const partnerId = parseInt(parts[2], 10);

                const booking = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(bookingCode);
                if (booking && booking.status === 'PARTNER_BROADCAST') {
                    await dispatchService.assignPartnerToBooking(booking.id, partnerId);
                    console.log(`[Partner Broadcast Claimed] Booking ${bookingCode} claimed by partner #${partnerId}`);
                } else {
                    await whatsappService.sendTextMessage(fromPhone, `⚠️ Sorry! Trip ${bookingCode} has already been accepted by another partner.`);
                }
            }
            return;
        }

        // Handle Standard Text Messages (Customer Inquiry / Command)
        if (message.type === 'text') {
            const incomingText = message.text.body.trim();
            console.log(`[Webhook Event] Inbound WhatsApp text from ${fromPhone}: "${incomingText}"`);

            // Auto Help / Welcome greeting
            if (incomingText.toLowerCase().includes('hi') || incomingText.toLowerCase().includes('book') || incomingText.toLowerCase().includes('help')) {
                const welcomeMsg = 
                    `👋 *Welcome to Flying Eagle Outstation Car Rental!*\n\n` +
                    `To get an instant fare quote, please reply in this format:\n\n` +
                    `*QUOTE [VehicleType] [Pickup] to [Drop] [DistanceKM] [NumDays]*\n\n` +
                    `*Examples of Vehicle Types:* Sedan, SUV, Innova, Tempo\n` +
                    `*Sample:* QUOTE Sedan Chennai to Trichy 330 2`;
                await whatsappService.sendTextMessage(fromPhone, welcomeMsg);
                return;
            }

            // Structured QUOTE command parser: "QUOTE Sedan Chennai to Trichy 330 2"
            if (incomingText.toUpperCase().startsWith('QUOTE')) {
                const parts = incomingText.split(' ');
                if (parts.length >= 6) {
                    const vTypeKeyword = parts[1].toLowerCase();
                    let vehicleType = 'Sedan (Dzire/Etios)';
                    if (vTypeKeyword.includes('suv')) vehicleType = 'SUV (Ertiga)';
                    if (vTypeKeyword.includes('innova')) vehicleType = 'Premium SUV (Innova Crysta)';
                    if (vTypeKeyword.includes('tempo')) vehicleType = 'Tempo Traveller (12 Seater)';

                    const dist = parseInt(parts[parts.length - 2], 10) || 300;
                    const days = parseInt(parts[parts.length - 1], 10) || 2;

                    const quote = tariffService.calculateTariff({
                        vehicle_type: vehicleType,
                        estimated_km: dist,
                        num_days: days
                    });

                    await whatsappService.sendTextMessage(fromPhone, quote.breakdown_text + `\n\nReply *CONFIRM* to book this trip!`);
                    return;
                }
            }
        }
    } catch (error) {
        console.error('[Meta Webhook Processing Error]', error);
    }
});

module.exports = router;
