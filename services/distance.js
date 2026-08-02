const ORS_API_KEY = process.env.ORS_API_KEY || '';
const ORS_BASE = 'https://api.openrouteservice.org';

async function geocode(placeText) {
    if (!ORS_API_KEY) {
        throw new Error('Distance API is not configured (missing ORS_API_KEY).');
    }
    const url = `${ORS_BASE}/geocode/search?api_key=${encodeURIComponent(ORS_API_KEY)}` +
        `&text=${encodeURIComponent(placeText)}&boundary.country=IN&size=1`;

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Geocoding failed for "${placeText}" (HTTP ${res.status})`);
    }
    const data = await res.json();
    const feature = data.features && data.features[0];
    if (!feature) {
        throw new Error(`Could not find location "${placeText}"`);
    }
    return feature.geometry.coordinates; // [lon, lat]
}

/**
 * Calculates driving distance (in KM) between two place names using OpenRouteService.
 * Returns { success: true, distance_km } or { success: false, error }.
 */
async function calculateRouteDistance(pickupText, dropText) {
    if (!ORS_API_KEY) {
        return { success: false, error: 'Distance API is not configured (missing ORS_API_KEY).' };
    }

    try {
        const [pickupCoords, dropCoords] = await Promise.all([
            geocode(pickupText),
            geocode(dropText)
        ]);

        const url = `${ORS_BASE}/v2/directions/driving-car` +
            `?api_key=${encodeURIComponent(ORS_API_KEY)}` +
            `&start=${pickupCoords[0]},${pickupCoords[1]}` +
            `&end=${dropCoords[0]},${dropCoords[1]}`;

        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Route calculation failed (HTTP ${res.status})`);
        }
        const data = await res.json();
        const distanceMeters = data?.features?.[0]?.properties?.segments?.[0]?.distance;
        if (typeof distanceMeters !== 'number') {
            throw new Error('No driving route found between these locations.');
        }

        // Round to the nearest 10 KM - a friendly approximate figure rather than a falsely precise one
        const distanceKm = Math.round(distanceMeters / 1000 / 10) * 10;
        return { success: true, distance_km: distanceKm };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = {
    calculateRouteDistance,
    geocode
};
