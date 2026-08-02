const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const EMPTY_SLOTS = {
    customer_name: null,
    pickup: null,
    drop: null,
    trip_date_text: null,
    num_days: null,
    vehicle_type: null
};

// Fallback list only used if a caller doesn't pass the live catalog - callers should
// always fetch the current vehicle_type names from the rate_cards table and pass them in,
// so newly-added vehicle types are recognized without any code change here.
const DEFAULT_VEHICLE_TYPES = [
    'Sedan (Dzire/Etios)', 'SUV (Ertiga)', 'Premium SUV (Innova Crysta)', 'Tempo Traveller (12 Seater)'
];

/**
 * Extracts outstation trip booking details from a customer's free-form WhatsApp message
 * using Gemini. Returns an object shaped like EMPTY_SLOTS (null for anything not mentioned).
 * On any failure (no API key, network error, bad response) returns all-null so the caller
 * can gracefully fall back to asking for the missing details directly.
 *
 * vehicleTypes: the current list of exact vehicle_type names from the rate card catalog -
 * Gemini is asked to return one of these exact strings, so the set of recognized vehicles
 * always matches whatever's actually bookable, without a hardcoded map to keep in sync.
 */
async function extractTripDetails(message, knownSlots = {}, vehicleTypes = DEFAULT_VEHICLE_TYPES) {
    if (!GEMINI_API_KEY) {
        return { ...EMPTY_SLOTS };
    }

    const prompt = `You are extracting structured outstation car-trip booking details from a customer's WhatsApp message for an Indian cab rental service.

Extract these fields ONLY if mentioned in the customer's LATEST message below:
- customer_name: the customer's name, or null
- pickup: pickup location, or null
- drop: drop-off location, or null
- trip_date_text: the date/time exactly as the customer phrased it (e.g. "this friday", "10 aug 6am", "tomorrow"), or null
- num_days: trip duration in days as an integer, or null
- vehicle_type: the customer's requested vehicle, mapped to the EXACT matching string from this list: ${JSON.stringify(vehicleTypes)} - or null if not mentioned or none are a reasonable match

Already known from earlier in the conversation (for context only - do not repeat these unless the customer restates/changes them): ${JSON.stringify(knownSlots)}

Customer's latest message: "${message}"

Respond with ONLY a raw JSON object with exactly these keys: customer_name, pickup, drop, trip_date_text, num_days, vehicle_type. No other text, no markdown formatting.`;

    try {
        const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
            })
        });

        if (!res.ok) {
            console.error(`[NLU] Gemini API error: HTTP ${res.status} ${await res.text()}`);
            return { ...EMPTY_SLOTS };
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return { ...EMPTY_SLOTS };

        const parsed = JSON.parse(text);
        return {
            customer_name: parsed.customer_name || null,
            pickup: parsed.pickup || null,
            drop: parsed.drop || null,
            trip_date_text: parsed.trip_date_text || null,
            num_days: (Number.isInteger(parsed.num_days) && parsed.num_days > 0) ? parsed.num_days : null,
            vehicle_type: vehicleTypes.includes(parsed.vehicle_type) ? parsed.vehicle_type : null
        };
    } catch (err) {
        console.error('[NLU] Extraction failed:', err.message);
        return { ...EMPTY_SLOTS };
    }
}

/**
 * Classifies whether a message shows genuine intent from a human customer to book,
 * inquire about, or discuss an outstation cab trip - as opposed to spam, an unrelated
 * question, or another automated bot's reply (away-message, notification, echo, etc.).
 * Defaults to false on any failure (no API key, network error) - staying silent is
 * safer than risking an automated back-and-forth with another bot.
 */
async function detectBookingIntent(message) {
    if (!GEMINI_API_KEY) return false;

    const prompt = `You are a filter guarding an Indian outstation cab rental WhatsApp bot from replying to spam or other bots.

Decide whether the message below shows genuine intent from a human customer to book, inquire about, or discuss an outstation car/cab trip.

Reply "NO" if the message is: spam or a promotion, an unrelated question, a plain greeting with no trip context, an automated bot's reply/away-message/delivery notification, or gibberish.
Reply "YES" only if there's a real signal the sender wants a cab/car/trip/outstation booking, or is describing travel plans (dates, places, vehicle type, etc.).

Message: "${message}"

Respond with ONLY the single word YES or NO.`;

    try {
        const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0 }
            })
        });

        if (!res.ok) {
            console.error(`[NLU] Intent detection API error: HTTP ${res.status}`);
            return false;
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return text.trim().toUpperCase().startsWith('YES');
    } catch (err) {
        console.error('[NLU] Intent detection failed:', err.message);
        return false;
    }
}

const EMPTY_AVAILABILITY = {
    is_available: null,
    vehicle_type: null,
    vehicle_number: null,
    location: null
};

/**
 * Extracts a partner's availability report from a free-form WhatsApp message
 * (e.g. "Sedan available in Chennai today", "not available today", "innova free
 * in Trichy, TN09CB1234"). Returns an object shaped like EMPTY_AVAILABILITY.
 * is_available is null when the message doesn't look like an availability report
 * at all (e.g. a greeting), true/false when it clearly does.
 */
async function extractAvailabilityUpdate(message, vehicleTypes = DEFAULT_VEHICLE_TYPES) {
    if (!GEMINI_API_KEY) {
        return { ...EMPTY_AVAILABILITY };
    }

    const prompt = `You are extracting a cab partner's vehicle availability report from a WhatsApp message for an Indian outstation cab rental service.

Extract these fields:
- is_available: true if they're reporting a vehicle IS available, false if they're reporting NOT available / no vehicle free, or null if the message doesn't look like an availability report at all (e.g. a greeting, unrelated question)
- vehicle_type: their vehicle, mapped to the EXACT matching string from this list: ${JSON.stringify(vehicleTypes)} - or null if not mentioned or none are a reasonable match
- vehicle_number: the vehicle registration number if mentioned, or null
- location: the city/place they say the vehicle is currently at, or null if not mentioned

Message: "${message}"

Respond with ONLY a raw JSON object with exactly these keys: is_available, vehicle_type, vehicle_number, location. No other text.`;

    try {
        const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
            })
        });

        if (!res.ok) {
            console.error(`[NLU] Availability extraction API error: HTTP ${res.status}`);
            return { ...EMPTY_AVAILABILITY };
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return { ...EMPTY_AVAILABILITY };

        const parsed = JSON.parse(text);
        return {
            is_available: typeof parsed.is_available === 'boolean' ? parsed.is_available : null,
            vehicle_type: vehicleTypes.includes(parsed.vehicle_type) ? parsed.vehicle_type : null,
            vehicle_number: parsed.vehicle_number || null,
            location: parsed.location || null
        };
    } catch (err) {
        console.error('[NLU] Availability extraction failed:', err.message);
        return { ...EMPTY_AVAILABILITY };
    }
}

module.exports = {
    extractTripDetails,
    detectBookingIntent,
    extractAvailabilityUpdate
};
