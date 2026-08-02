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

const VEHICLE_TYPE_MAP = {
    Sedan: 'Sedan (Dzire/Etios)',
    SUV: 'SUV (Ertiga)',
    Innova: 'Premium SUV (Innova Crysta)',
    Tempo: 'Tempo Traveller (12 Seater)'
};

/**
 * Extracts outstation trip booking details from a customer's free-form WhatsApp message
 * using Gemini. Returns an object shaped like EMPTY_SLOTS (null for anything not mentioned).
 * On any failure (no API key, network error, bad response) returns all-null so the caller
 * can gracefully fall back to asking for the missing details directly.
 */
async function extractTripDetails(message, knownSlots = {}) {
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
- vehicle_type: one of "Sedan", "SUV", "Innova", "Tempo" (map the customer's wording to the closest of these four categories), or null

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
            vehicle_type: ['Sedan', 'SUV', 'Innova', 'Tempo'].includes(parsed.vehicle_type) ? parsed.vehicle_type : null
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

module.exports = {
    extractTripDetails,
    detectBookingIntent,
    VEHICLE_TYPE_MAP
};
