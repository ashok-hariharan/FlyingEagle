const db = require('../config/database');
const distanceService = require('./distance');

/**
 * Records/updates a partner's current availability status (rolling upsert - one row
 * per partner). Attempts to geocode the location for later proximity ranking; if
 * geocoding fails or isn't configured, the report is still stored without coordinates.
 */
async function reportAvailability(partnerId, { is_available, vehicle_type, vehicle_number, location }) {
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

    const existing = db.prepare('SELECT id FROM partner_availability WHERE partner_id = ?').get(partnerId);

    if (existing) {
        db.prepare(`
            UPDATE partner_availability
            SET is_available = ?, vehicle_type = ?, vehicle_number = ?, location = ?,
                location_lat = ?, location_lon = ?, reported_at = CURRENT_TIMESTAMP
            WHERE partner_id = ?
        `).run(is_available ? 1 : 0, vehicle_type || null, vehicle_number || null, location || null, lat, lon, partnerId);
    } else {
        db.prepare(`
            INSERT INTO partner_availability (partner_id, is_available, vehicle_type, vehicle_number, location, location_lat, location_lon)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(partnerId, is_available ? 1 : 0, vehicle_type || null, vehicle_number || null, location || null, lat, lon);
    }

    return db.prepare('SELECT * FROM partner_availability WHERE partner_id = ?').get(partnerId);
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
 * Filters out partners explicitly marked unavailable (no report on file = still
 * eligible, per the "treat as available until they say otherwise" default), then
 * sorts the rest nearest-first to the pickup location when we have coordinates for
 * both sides. Partners with no location on file keep their original relative order,
 * placed after any partner we could actually rank.
 */
async function filterAndRankPartners(partners, pickupLocation) {
    const availability = db.prepare('SELECT * FROM partner_availability').all();
    const byPartnerId = new Map(availability.map(a => [a.partner_id, a]));

    const eligible = partners.filter(p => {
        const a = byPartnerId.get(p.id);
        return !a || a.is_available; // no record on file -> still eligible
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
