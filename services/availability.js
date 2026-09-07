const db = require('../config/database');
const distanceService = require('./distance');

/**
 * Records/updates a partner's availability (one row per partner+vehicle_type - upserted
 * whenever they report). If no specific vehicle_type is mentioned in their message, the
 * update is applied to every vehicle type that partner offers, so a plain "not available
 * today" still covers their whole fleet - but a message naming one vehicle only ever
 * touches that vehicle's status, never their others.
 *
 * unavailable_from/unavailable_until (YYYY-MM-DD, or null) scope how long an
 * is_available=false report holds: outside that window the partner+vehicle combo goes back
 * to being treated as available. Leaving both null on an unavailable report means "until
 * further notice" (matches a partner who didn't mention any dates at all).
 *
 * Returns the array of records touched (usually one, more if fanned out across a fleet).
 */
async function reportAvailability(partnerId, { is_available, vehicle_type, vehicle_number, location, unavailable_from, unavailable_until }) {
    let lat = null;
    let lon = null;

    if (is_available && location) {
        try {
            const coords = await distanceService.geocode(location);
            lon = coords[0];
            lat = coords[1];
        } catch (err) {
            console.warn(`[Availability] Could not geocode "${location}" for partner #${partnerId}: ${err.message}`);
        }
    }

    let vehicleTypes = vehicle_type ? [vehicle_type] : [];
    if (vehicleTypes.length === 0) {
        const partner = db.prepare('SELECT vehicles_offered FROM partners WHERE id = ?').get(partnerId);
        try { vehicleTypes = JSON.parse(partner?.vehicles_offered || '[]'); } catch (e) { vehicleTypes = []; }
    }

    // A date range only means anything for an unavailable report - an "available" report
    // has no window to expire out of.
    const fromDate = is_available ? null : (unavailable_from || null);
    const untilDate = is_available ? null : (unavailable_until || null);

    const upsert = db.prepare(`
        INSERT INTO partner_availability
            (partner_id, vehicle_type, is_available, vehicle_number, location, location_lat, location_lon, unavailable_from, unavailable_until, reported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(partner_id, vehicle_type) DO UPDATE SET
            is_available = excluded.is_available,
            vehicle_number = excluded.vehicle_number,
            location = excluded.location,
            location_lat = excluded.location_lat,
            location_lon = excluded.location_lon,
            unavailable_from = excluded.unavailable_from,
            unavailable_until = excluded.unavailable_until,
            reported_at = CURRENT_TIMESTAMP
    `);
    const selectOne = db.prepare('SELECT * FROM partner_availability WHERE partner_id = ? AND vehicle_type = ?');

    return vehicleTypes.map(vt => {
        upsert.run(partnerId, vt, is_available ? 1 : 0, vehicle_number || null, location || null, lat, lon, fromDate, untilDate);
        return selectOne.get(partnerId, vt);
    });
}

// Haversine straight-line distance (KM) between two [lon, lat] coordinate pairs.
// Used purely for ranking/priority order, not billing, so an approximation is fine.
function haversineDistanceKm([lon1, lat1], [lon2, lat2]) {
    const R = 6371;
    const toRad = deg => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Filters out partners explicitly marked unavailable for the requested vehicle type on the
 * given trip date, then sorts the rest nearest-first to the pickup location when we have
 * coordinates for both sides. A partner stays eligible when: there's no availability report
 * on file for that vehicle type at all, the report says available, or the report's
 * unavailable date window doesn't cover the trip date. Partners with no location on file
 * keep their original relative order, placed after any partner we could actually rank.
 */
async function filterAndRankPartners(partners, pickupLocation, vehicleType, tripDate) {
    const tripDateOnly = tripDate ? String(tripDate).slice(0, 10) : null; // YYYY-MM-DD

    const availability = vehicleType
        ? db.prepare('SELECT * FROM partner_availability WHERE vehicle_type = ?').all(vehicleType)
        : [];
    const byPartnerId = new Map(availability.map(a => [a.partner_id, a]));

    const eligible = partners.filter(p => {
        const a = byPartnerId.get(p.id);
        if (!a || a.is_available) return true; // no report for this vehicle type, or reported available

        // Reported unavailable - only exclude if the trip date actually falls inside their
        // stated window. No window at all ("until further notice") always excludes; if we
        // don't know the trip date to compare against, be conservative and exclude too.
        if (!a.unavailable_from && !a.unavailable_until) return false;
        if (!tripDateOnly) return false;

        if (a.unavailable_from && tripDateOnly < a.unavailable_from) return true;
        if (a.unavailable_until && tripDateOnly > a.unavailable_until) return true;
        return false; // falls within the unavailable window
    });

    let pickupCoords = null;
    try {
        pickupCoords = await distanceService.geocode(pickupLocation);
    } catch (err) {
        console.warn(`[Availability] Could not geocode pickup "${pickupLocation}" for ranking: ${err.message}`);
    }

    if (!pickupCoords) {
        return eligible; // can't rank without a pickup point - fall back to original order
    }

    const withDistance = eligible.map(p => {
        const a = byPartnerId.get(p.id);
        if (a && a.location_lat != null && a.location_lon != null) {
            return { partner: p, distanceKm: haversineDistanceKm(pickupCoords, [a.location_lon, a.location_lat]) };
        }
        return { partner: p, distanceKm: null };
    });

    withDistance.sort((a, b) => {
        if (a.distanceKm == null && b.distanceKm == null) return 0;
        if (a.distanceKm == null) return 1;
        if (b.distanceKm == null) return -1;
        return a.distanceKm - b.distanceKm;
    });

    return withDistance.map(x => x.partner);
}

module.exports = {
    reportAvailability,
    filterAndRankPartners
};
