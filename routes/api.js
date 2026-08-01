const express = require('express');
const router = express.Router();
const db = require('../config/database');
const tariffService = require('../services/tariff');
const dispatchService = require('../services/dispatch');
const whatsappService = require('../services/whatsapp');

// 1b. WhatsApp Web Connection Status & QR Code Endpoint
router.get('/whatsapp/status', (req, res) => {
    res.json({ success: true, ...whatsappService.getStatus() });
});
router.post('/quick-quote', (req, res) => {
    try {
        const { vehicle_type, estimated_km, num_days, is_night_trip } = req.body;
        const quote = tariffService.calculateTariff({
            vehicle_type,
            estimated_km,
            num_days,
            is_night_trip
        });
        res.json({ success: true, quote });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 2. Fetch All Bookings
router.get('/bookings', (req, res) => {
    try {
        const bookings = db.prepare(`
            SELECT b.*, p.name as partner_name, p.phone as partner_phone 
            FROM bookings b
            LEFT JOIN partners p ON b.assigned_partner_id = p.id
            ORDER BY b.id DESC
        `).all();
        res.json({ success: true, bookings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Create New Booking
router.post('/bookings', async (req, res) => {
    try {
        const {
            customer_name,
            customer_phone,
            pickup_location,
            drop_location,
            trip_start_date,
            trip_end_date,
            num_days,
            estimated_km,
            vehicle_type,
            is_night_trip,
            notes
        } = req.body;

        // Calculate tariff
        const quote = tariffService.calculateTariff({
            vehicle_type,
            estimated_km,
            num_days,
            is_night_trip
        });

        const bookingCode = `FL-${new Date().getFullYear()}-${Math.floor(100 + Math.random() * 900)}`;

        const stmt = db.prepare(`
            INSERT INTO bookings (
                booking_code, customer_name, customer_phone, pickup_location, drop_location,
                trip_start_date, trip_end_date, num_days, estimated_km, vehicle_type,
                calculated_amount, status, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
        `);

        const result = stmt.run(
            bookingCode,
            customer_name,
            customer_phone,
            pickup_location,
            drop_location,
            trip_start_date,
            trip_end_date || trip_start_date,
            num_days || 1,
            estimated_km,
            vehicle_type,
            quote.total_amount,
            notes || ''
        );

        const newBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

        // Send confirmation quote to customer via WhatsApp
        await whatsappService.sendTextMessage(
            customer_phone,
            `Hello ${customer_name}! Here is your outstation trip quotation:\n\n` + quote.breakdown_text
        );

        res.json({ success: true, booking: newBooking, quote });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 3b. Update Existing Booking
router.put('/bookings/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const existing = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Booking not found.' });
        }

        const {
            customer_name,
            customer_phone,
            pickup_location,
            drop_location,
            trip_start_date,
            trip_end_date,
            num_days,
            estimated_km,
            vehicle_type,
            notes
        } = req.body;

        const quote = tariffService.calculateTariff({ vehicle_type, estimated_km, num_days });

        db.prepare(`
            UPDATE bookings
            SET customer_name = ?, customer_phone = ?, pickup_location = ?, drop_location = ?,
                trip_start_date = ?, trip_end_date = ?, num_days = ?, estimated_km = ?,
                vehicle_type = ?, calculated_amount = ?, notes = ?
            WHERE id = ?
        `).run(
            customer_name,
            customer_phone,
            pickup_location,
            drop_location,
            trip_start_date,
            trip_end_date || trip_start_date,
            num_days || 1,
            estimated_km,
            vehicle_type,
            quote.total_amount,
            notes || existing.notes || '',
            id
        );

        const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
        res.json({ success: true, booking: updated, quote });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 3c. Delete Booking
router.delete('/bookings/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const result = db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
        if (result.changes === 0) {
            return res.status(404).json({ success: false, error: 'Booking not found.' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Trigger WhatsApp Broadcast to Tie-up Partners
router.post('/bookings/:id/broadcast', async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id, 10);
        const broadcastResult = await dispatchService.broadcastToPartners(bookingId);
        res.json(broadcastResult);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Manually Assign Booking to Partner / Fleet
router.post('/bookings/:id/assign', async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id, 10);
        const { partner_id } = req.body;
        const assignResult = await dispatchService.assignPartnerToBooking(bookingId, partner_id);
        res.json(assignResult);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. Update Driver & Vehicle Info (Pre-Trip Dispatch T-4h)
router.post('/bookings/:id/dispatch-driver', async (req, res) => {
    try {
        const bookingId = parseInt(req.params.id, 10);
        const { driver_name, driver_phone, vehicle_number } = req.body;

        const dispatchResult = await dispatchService.dispatchTripVoucherToCustomer(bookingId, {
            driver_name,
            driver_phone,
            vehicle_number
        });

        res.json(dispatchResult);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 7. Rate Cards API
router.get('/rate-cards', (req, res) => {
    try {
        const rateCards = db.prepare('SELECT * FROM rate_cards ORDER BY id ASC').all();
        res.json({ success: true, rateCards });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/rate-cards/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { per_km_rate, min_km_per_day, driver_batta_per_day, night_charge } = req.body;

        db.prepare(`
            UPDATE rate_cards 
            SET per_km_rate = ?, min_km_per_day = ?, driver_batta_per_day = ?, night_charge = ?
            WHERE id = ?
        `).run(per_km_rate, min_km_per_day, driver_batta_per_day, night_charge, id);

        const updated = db.prepare('SELECT * FROM rate_cards WHERE id = ?').get(id);
        res.json({ success: true, rateCard: updated });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 7b. Delete Rate Card
router.delete('/rate-cards/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const result = db.prepare('DELETE FROM rate_cards WHERE id = ?').run(id);
        if (result.changes === 0) {
            return res.status(404).json({ success: false, error: 'Rate card not found.' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 8. Partners API
router.get('/partners', (req, res) => {
    try {
        const partners = db.prepare('SELECT * FROM partners ORDER BY is_internal DESC, id ASC').all();
        const formatted = partners.map(p => ({
            ...p,
            vehicles_offered: JSON.parse(p.vehicles_offered || '[]')
        }));
        res.json({ success: true, partners: formatted });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/partners', (req, res) => {
    try {
        const { name, phone, is_internal, vehicles_offered } = req.body;
        const stmt = db.prepare(`
            INSERT INTO partners (name, phone, is_internal, vehicles_offered)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(name, phone, is_internal ? 1 : 0, JSON.stringify(vehicles_offered || []));
        const newPartner = db.prepare('SELECT * FROM partners WHERE id = ?').get(result.lastInsertRowid);
        res.json({ success: true, partner: newPartner });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 8b. Update Existing Partner
router.put('/partners/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const existing = db.prepare('SELECT * FROM partners WHERE id = ?').get(id);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Partner not found.' });
        }

        const { name, phone, is_internal, vehicles_offered } = req.body;

        db.prepare(`
            UPDATE partners
            SET name = ?, phone = ?, is_internal = ?, vehicles_offered = ?
            WHERE id = ?
        `).run(name, phone, is_internal ? 1 : 0, JSON.stringify(vehicles_offered || []), id);

        const updated = db.prepare('SELECT * FROM partners WHERE id = ?').get(id);
        res.json({ success: true, partner: { ...updated, vehicles_offered: JSON.parse(updated.vehicles_offered || '[]') } });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 8c. Delete Partner
router.delete('/partners/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const result = db.prepare('DELETE FROM partners WHERE id = ?').run(id);
        if (result.changes === 0) {
            return res.status(404).json({ success: false, error: 'Partner not found.' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
