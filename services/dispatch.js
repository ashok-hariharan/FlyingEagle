const db = require('../config/database');
const whatsapp = require('./whatsapp');

/**
 * Broadcasts an unassigned booking to tie-up travel partners via WhatsApp.
 */
async function broadcastToPartners(bookingId) {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);

    if (!booking) {
        throw new Error(`Booking #${bookingId} not found.`);
    }

    // Fetch active tie-up partners (excluding internal fleet) who offer this vehicle type
    const allPartners = db.prepare('SELECT * FROM partners WHERE is_active = 1 AND is_internal = 0').all();
    const eligiblePartners = allPartners.filter(p => {
        try {
            const vehicles = JSON.parse(p.vehicles_offered || '[]');
            return vehicles.includes(booking.vehicle_type);
        } catch (e) {
            return false;
        }
    });

    if (eligiblePartners.length === 0) {
        console.warn(`[Dispatch] No eligible tie-up partners found for vehicle type '${booking.vehicle_type}'.`);
        return { success: false, count: 0, message: 'No eligible tie-up partners found for this vehicle category.' };
    }

    // Update booking status
    db.prepare(`UPDATE bookings SET status = 'PARTNER_BROADCAST' WHERE id = ?`).run(bookingId);

    const broadcastMessage = 
        `🚨 *NEW OUTSTATION TRIP OFFER* 🚕\n` +
        `• Booking Ref: ${booking.booking_code}\n` +
        `• Vehicle Required: *${booking.vehicle_type}*\n` +
        `• Pickup: ${booking.pickup_location}\n` +
        `• Drop: ${booking.drop_location}\n` +
        `• Start Date: ${booking.trip_start_date}\n` +
        `• Estimated KM: ${booking.estimated_km} KM (${booking.num_days} Days)\n` +
        `• Agreed Payout: ₹${booking.calculated_amount.toLocaleString('en-IN')}\n\n` +
        `Reply *ACCEPT ${booking.booking_code}* to claim this trip!`;

    const broadcastResults = [];
    for (const partner of eligiblePartners) {
        const result = await whatsapp.sendInteractiveButtons(
            partner.phone,
            broadcastMessage,
            [
                { id: `ACCEPT_${booking.booking_code}_${partner.id}`, title: '✅ ACCEPT TRIP' },
                { id: `DECLINE_${booking.booking_code}_${partner.id}`, title: '❌ PASS' }
            ]
        );
        broadcastResults.push({ partner: partner.name, phone: partner.phone, result });
    }

    return {
        success: true,
        count: eligiblePartners.length,
        partners: eligiblePartners.map(p => p.name),
        results: broadcastResults
    };
}

/**
 * Offers a booking to the internal (own) fleet first via WhatsApp ACCEPT/DECLINE.
 * Falls back to broadcasting to tie-up partners immediately if no internal fleet
 * vehicle covers the requested category, or once the internal fleet explicitly declines.
 */
async function offerToOwnFleet(bookingId) {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);

    if (!booking) {
        throw new Error(`Booking #${bookingId} not found.`);
    }

    const internalFleet = db.prepare('SELECT * FROM partners WHERE is_active = 1 AND is_internal = 1').all();
    const eligibleFleet = internalFleet.filter(p => {
        try {
            const vehicles = JSON.parse(p.vehicles_offered || '[]');
            return vehicles.includes(booking.vehicle_type);
        } catch (e) {
            return false;
        }
    });

    if (eligibleFleet.length === 0) {
        console.warn(`[Dispatch] No own-fleet vehicle available for '${booking.vehicle_type}' - going straight to tie-up partners.`);
        return await broadcastToPartners(bookingId);
    }

    db.prepare(`UPDATE bookings SET status = 'INTERNAL_OFFERED' WHERE id = ?`).run(bookingId);

    const offerMessage =
        `🚕 *NEW TRIP - OWN FLEET FIRST REFUSAL* 🚨\n` +
        `• Booking Ref: ${booking.booking_code}\n` +
        `• Vehicle Required: *${booking.vehicle_type}*\n` +
        `• Pickup: ${booking.pickup_location}\n` +
        `• Drop: ${booking.drop_location}\n` +
        `• Start Date: ${booking.trip_start_date}\n` +
        `• Estimated KM: ${booking.estimated_km} KM (${booking.num_days} Days)\n` +
        `• Fare: ₹${booking.calculated_amount.toLocaleString('en-IN')}\n\n` +
        `Reply *ACCEPT ${booking.booking_code}* if an own-fleet vehicle is available, or *DECLINE ${booking.booking_code}* to release this trip to our tie-up partners.`;

    for (const fleet of eligibleFleet) {
        await whatsapp.sendTextMessage(fleet.phone, offerMessage);
    }

    return { success: true, stage: 'internal_offered', count: eligibleFleet.length, partners: eligibleFleet.map(p => p.name) };
}

/**
 * Accepts an own-fleet first-refusal offer on behalf of the admin/dispatcher (e.g. from the
 * dashboard), without requiring a WhatsApp reply from the fleet's own number - useful since
 * that number often can't reliably message itself (self-chat limitation).
 */
async function acceptOwnFleetOffer(bookingId) {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) {
        throw new Error(`Booking #${bookingId} not found.`);
    }

    const internalFleet = db.prepare('SELECT * FROM partners WHERE is_active = 1 AND is_internal = 1').all();
    const eligiblePartner = internalFleet.find(p => {
        try {
            const vehicles = JSON.parse(p.vehicles_offered || '[]');
            return vehicles.includes(booking.vehicle_type);
        } catch (e) {
            return false;
        }
    });

    if (!eligiblePartner) {
        throw new Error('No eligible internal fleet partner found for this vehicle type.');
    }

    return await assignPartnerToBooking(bookingId, eligiblePartner.id);
}

/**
 * Assigns a booking to a specific partner (Internal or Tie-up) and notifies customer.
 */
async function assignPartnerToBooking(bookingId, partnerId) {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(partnerId);

    if (!booking || !partner) {
        throw new Error('Invalid booking ID or partner ID.');
    }

    db.prepare(`
        UPDATE bookings 
        SET assigned_partner_id = ?, status = 'ASSIGNED' 
        WHERE id = ?
    `).run(partnerId, bookingId);

    // 1. Notify Partner
    const partnerMsg = `🎉 *TRIP CONFIRMED & ASSIGNED*\n` +
        `Booking ${booking.booking_code} is assigned to ${partner.name}.\n` +
        `Pickup: ${booking.pickup_location} on ${booking.trip_start_date}.\n\n` +
        `📋 Once ready (ideally 2-4 hours before pickup), reply with driver & vehicle details in this format (if you have multiple trips with us, the booking ref tells us which one this is for):\n` +
        `*DRIVER ${booking.booking_code} | <Driver Name> | <Driver Phone> | <Vehicle Number>*\n\n` +
        `Example:\n*DRIVER ${booking.booking_code} | Senthil Kumar | +919789012345 | TN 09 CB 4567*\n\n` +
        `We'll send this straight to the customer.`;
    await whatsapp.sendTextMessage(partner.phone, partnerMsg);

    // 2. Notify Customer
    const customerMsg = `✅ *BOOKING CONFIRMED!* 🚕\n` +
        `Your trip ${booking.booking_code} (${booking.vehicle_type}) is locked.\n` +
        `Pickup: ${booking.pickup_location}\n` +
        `Drop: ${booking.drop_location}\n` +
        `Date: ${booking.trip_start_date}\n` +
        `Total Estimated Fare: ₹${booking.calculated_amount.toLocaleString('en-IN')}\n\n` +
        `Driver & Vehicle details will be shared 2-4 hours prior to departure!`;
    await whatsapp.sendTextMessage(booking.customer_phone, customerMsg);

    return { success: true, partner: partner.name, status: 'ASSIGNED' };
}

/**
 * Auto-dispatches driver and vehicle info to customer (T-4 hours before trip)
 */
async function dispatchTripVoucherToCustomer(bookingId, { driver_name, driver_phone, vehicle_number }) {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);

    if (!booking) {
        throw new Error('Booking not found.');
    }

    db.prepare(`
        UPDATE bookings 
        SET driver_name = ?, driver_phone = ?, vehicle_number = ?, status = 'IN_PROGRESS' 
        WHERE id = ?
    `).run(driver_name, driver_phone, vehicle_number, bookingId);

    const tripCard = 
        `🚕 *YOUR TRIP DRIVER & VEHICLE DETAILS* 🚘\n` +
        `-----------------------------------\n` +
        `• Booking Ref: *${booking.booking_code}*\n` +
        `• Vehicle: *${booking.vehicle_type}*\n` +
        `• Vehicle Reg No: *${vehicle_number}*\n` +
        `• Driver Name: *${driver_name}*\n` +
        `• Driver Phone: *${driver_phone}*\n` +
        `-----------------------------------\n` +
        `• Pickup Point: ${booking.pickup_location}\n` +
        `• Departure Time: ${booking.trip_start_date}\n\n` +
        `Have a safe & safe outstation journey with Flying Eagle!`;

    await whatsapp.sendTextMessage(booking.customer_phone, tripCard);

    return { success: true, status: 'IN_PROGRESS', voucher_sent: true };
}

module.exports = {
    broadcastToPartners,
    offerToOwnFleet,
    acceptOwnFleetOffer,
    assignPartnerToBooking,
    dispatchTripVoucherToCustomer
};
