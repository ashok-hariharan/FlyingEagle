const ORS_API_KEY = process.env.ORS_API_KEY || '';
const ORS_BASE = 'https://api.openrouteservice.org';

// Colloquial/alternate names for Indian cities, mapped to whichever spelling ORS's gazetteer
// resolves cleanly - covers both real aliases ("Trichy" -> Tiruchirappalli) and the canonical
// spelling itself, since even typing the canonical name alone doesn't reliably disambiguate a
// same-named locality in a *different* city (see geocode() below for why). Weighted toward
// Tamil Nadu/South India given this app's focus, plus the major national metros an outstation
// trip might realistically run to.
const CITY_ALIASES = {
    'chennai': 'Chennai', 'madras': 'Chennai',
    'tiruchirappalli': 'Tiruchirappalli', 'trichy': 'Tiruchirappalli', 'tiruchi': 'Tiruchirappalli',
    'coimbatore': 'Coimbatore', 'cbe': 'Coimbatore',
    'madurai': 'Madurai',
    'salem': 'Salem',
    'tirunelveli': 'Tirunelveli', 'nellai': 'Tirunelveli',
    'thoothukudi': 'Thoothukudi', 'tuticorin': 'Thoothukudi', 'tuty': 'Thoothukudi',
    'thanjavur': 'Thanjavur', 'tanjore': 'Thanjavur',
    'vellore': 'Vellore',
    'puducherry': 'Puducherry', 'pondicherry': 'Puducherry', 'pondy': 'Puducherry',
    'erode': 'Erode',
    'dindigul': 'Dindigul',
    'karur': 'Karur',
    'kanchipuram': 'Kanchipuram', 'kanchi': 'Kanchipuram',
    'chidambaram': 'Chidambaram',
    'kumbakonam': 'Kumbakonam',
    'nagercoil': 'Nagercoil',
    'udhagamandalam': 'Ooty', 'udagamandalam': 'Ooty', 'ooty': 'Ooty',
    'kodaikanal': 'Kodaikanal',
    'bengaluru': 'Bengaluru', 'bangalore': 'Bengaluru',
    'mysuru': 'Mysuru', 'mysore': 'Mysuru',
    'mangaluru': 'Mangaluru', 'mangalore': 'Mangaluru',
    'kochi': 'Kochi', 'cochin': 'Kochi', 'ernakulam': 'Kochi',
    'thiruvananthapuram': 'Thiruvananthapuram', 'trivandrum': 'Thiruvananthapuram',
    'kozhikode': 'Kozhikode', 'calicut': 'Kozhikode',
    'thrissur': 'Thrissur', 'trichur': 'Thrissur',
    'kollam': 'Kollam', 'quilon': 'Kollam',
    'hyderabad': 'Hyderabad',
    'visakhapatnam': 'Visakhapatnam', 'vizag': 'Visakhapatnam',
    'vijayawada': 'Vijayawada',
    'mumbai': 'Mumbai', 'bombay': 'Mumbai',
    'kolkata': 'Kolkata', 'calcutta': 'Kolkata',
    'new delhi': 'Delhi', 'delhi': 'Delhi',
    'pune': 'Pune', 'poona': 'Pune',
    'ahmedabad': 'Ahmedabad',
    'vadodara': 'Vadodara', 'baroda': 'Vadodara',
    'goa': 'Goa', 'panaji': 'Goa'
};

// Longest alias first, so "new delhi" is matched as a phrase before the bare "delhi"
// substring inside it would otherwise match.
const SORTED_ALIASES = Object.keys(CITY_ALIASES).sort((a, b) => b.length - a.length);

// A city's own coordinates don't change - no reason to re-geocode "Chennai" on every booking.
const cityAnchorCache = new Map();

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Finds a known city name/alias as a whole word (or phrase) anywhere in the text,
// case-insensitively. Returns { canonical, remainder } - remainder is what's left of the
// text with that city mention removed - or null if no known city is mentioned at all.
function detectCityMention(placeText) {
    for (const alias of SORTED_ALIASES) {
        const re = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i');
        const match = placeText.match(re);
        if (match) {
            const remainder = (placeText.slice(0, match.index) + placeText.slice(match.index + match[0].length))
                .replace(/^[\s,.-]+|[\s,.-]+$/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
            return { canonical: CITY_ALIASES[alias], remainder };
        }
    }
    return null;
}

async function geocodeRaw(text, focusPoint) {
    let url = `${ORS_BASE}/geocode/search?api_key=${encodeURIComponent(ORS_API_KEY)}` +
        `&text=${encodeURIComponent(text)}&boundary.country=IN&size=1`;
    if (focusPoint) {
        url += `&focus.point.lon=${focusPoint[0]}&focus.point.lat=${focusPoint[1]}`;
    }

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Geocoding failed for "${text}" (HTTP ${res.status})`);
    }
    const data = await res.json();
    const feature = data.features && data.features[0];
    if (!feature) {
        throw new Error(`Could not find location "${text}"`);
    }
    return feature.geometry.coordinates; // [lon, lat]
}

async function getCityAnchor(canonicalName) {
    if (cityAnchorCache.has(canonicalName)) return cityAnchorCache.get(canonicalName);
    const coords = await geocodeRaw(canonicalName);
    cityAnchorCache.set(canonicalName, coords);
    return coords;
}

// A stripped-remainder result this far from the city we biased toward is treated as a
// failed strip, not a real answer - see the "Madurai Junction" case in geocode() below.
const STRIP_SANITY_RADIUS_KM = 80;

/**
 * Geocodes a free-text place name to [lon, lat].
 *
 * A plain free-text search scores every word as an equally-weighted keyword rather than
 * requiring "<city> <locality>" to mean "that locality, within that city" - so a same-named
 * locality in a completely different (more prominently-mapped) city can outrank the correct
 * one, regardless of which city word is used. E.g. "Trichy thillai nagar" was resolving to
 * Thillai Nagar in Chidambaram - ~150km from the Thillai Nagar in Tiruchirappalli actually
 * meant - and typing the canonical "Tiruchirappalli" instead of "Trichy" made no difference.
 *
 * When a known city name/colloquial alias appears in the text, this resolves that city's own
 * coordinates first (cached) and re-geocodes just the remaining text with a geographic bias
 * toward it, which correctly favors the nearby match - EXCEPT when the remainder alone is too
 * generic to search safely (e.g. "Madurai Junction" stripped down to bare "Junction" matches
 * "Guntakal Junction" in a different state entirely, since a focus bias only nudges ranking,
 * it doesn't exclude a much more prominent same-named place far away). So the stripped result
 * is only trusted if it actually lands near the city it was biased toward; otherwise this
 * falls back to a plain search of the full, original text - Pelias's own scoring already
 * handles a well-known exact phrase like "Madurai Junction" correctly without our help.
 */
async function geocode(placeText) {
    if (!ORS_API_KEY) {
        throw new Error('Distance API is not configured (missing ORS_API_KEY).');
    }

    const cityMention = detectCityMention(placeText);
    if (!cityMention) {
        return await geocodeRaw(placeText);
    }
    if (!cityMention.remainder) {
        // The whole text was just the city name - its own coordinates are the answer.
        return await getCityAnchor(cityMention.canonical);
    }

    let anchor, strippedResult;
    try {
        anchor = await getCityAnchor(cityMention.canonical);
        strippedResult = await geocodeRaw(cityMention.remainder, anchor);
        if (haversineKm(strippedResult, anchor) <= STRIP_SANITY_RADIUS_KM) {
            return strippedResult;
        }
        console.warn(`[Distance] Stripped-remainder match for "${placeText}" landed far from ${cityMention.canonical}, falling back to the full text.`);
    } catch (err) {
        console.warn(`[Distance] City-biased geocoding failed for "${placeText}": ${err.message}`);
    }

    try {
        return await geocodeRaw(placeText);
    } catch (err) {
        if (strippedResult) return strippedResult; // still better than a hard failure
        throw err;
    }
}

// Haversine straight-line distance (KM) between two [lon, lat] coordinate pairs - used only
// to size how far apart two geocoding candidates for the *same* text are, not for billing.
function haversineKm([lon1, lat1], [lon2, lat2]) {
    const R = 6371;
    const toRad = deg => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Beyond this gap, two geocoding candidates for the same text are treated as genuinely
// different real places rather than just noise within the same neighbourhood.
const AMBIGUITY_THRESHOLD_KM = 15;

/**
 * Resolves a place name to coordinates using the same city-biased logic as geocode(), and
 * also flags whether the name is genuinely ambiguous: whether OpenRouteService's plain,
 * unbiased search for that exact text turns up a real alternate place more than
 * AMBIGUITY_THRESHOLD_KM away from what we're actually going with. A large gap there means
 * the text plausibly names more than one real location (the same disambiguation problem
 * geocode() fixes when a known city is mentioned, generalized to catch it even when the bias
 * fix doesn't apply or a plain search alone is already inconsistent) - worth a quick human
 * confirmation rather than silently trusting either guess.
 */
async function resolveLocation(placeText) {
    const resolvedCoords = await geocode(placeText);

    let ambiguous = false;
    try {
        const plainCoords = await geocodeRaw(placeText);
        if (haversineKm(resolvedCoords, plainCoords) > AMBIGUITY_THRESHOLD_KM) {
            ambiguous = true;
        }
    } catch (err) {
        // Can't compare - don't block the booking over a failed sanity-check call.
    }

    return { coords: resolvedCoords, ambiguous };
}

/**
 * Looks up the PIN code for a coordinate via Nominatim (OpenStreetMap's own geocoder).
 * OpenRouteService's own India data doesn't carry postal codes at all, but Nominatim's raw
 * OSM address tags usually do. Only called for the occasional ambiguous-location
 * confirmation, well within Nominatim's usage policy (a handful of requests per booking at
 * most, well under its ~1 request/second limit) - a real, identifying User-Agent is required
 * by that policy. Returns null (never throws) if no PIN code is available.
 */
async function getPincode([lon, lat]) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'FlyingEagle-OutstationDispatch/1.0 (WhatsApp booking bot)' }
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.address?.postcode || null;
    } catch (err) {
        return null;
    }
}

async function directionsDistanceKm(pickupCoords, dropCoords) {
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
    return Math.round(distanceMeters / 1000 / 10) * 10;
}

/**
 * Calculates driving distance (in KM) between two already-geocoded [lon, lat] points -
 * for when the caller has already resolved (and possibly had the customer confirm) both
 * ends via resolveLocation(), so there's no reason to geocode the text again.
 * Returns { success: true, distance_km } or { success: false, error }.
 */
async function calculateRouteDistanceFromCoords(pickupCoords, dropCoords) {
    if (!ORS_API_KEY) {
        return { success: false, error: 'Distance API is not configured (missing ORS_API_KEY).' };
    }
    try {
        const distance_km = await directionsDistanceKm(pickupCoords, dropCoords);
        return { success: true, distance_km };
    } catch (err) {
        return { success: false, error: err.message };
    }
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
        const distance_km = await directionsDistanceKm(pickupCoords, dropCoords);
        return { success: true, distance_km };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = {
    calculateRouteDistance,
    calculateRouteDistanceFromCoords,
    resolveLocation,
    getPincode,
    geocode
};
