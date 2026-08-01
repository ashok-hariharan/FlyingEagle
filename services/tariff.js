const db = require('../config/database');

/**
 * Calculates outstation trip tariff based on standard rate card logic.
 * Formula: MAX(actual_km, min_km_per_day * num_days) * per_km_rate + (driver_batta * num_days) + night_charge
 */
function calculateTariff({ vehicle_type, estimated_km, num_days, is_night_trip = false }) {
    const rateCard = db.prepare('SELECT * FROM rate_cards WHERE vehicle_type = ?').get(vehicle_type);
    
    if (!rateCard) {
        throw new Error(`Invalid vehicle type '${vehicle_type}'. No rate card found.`);
    }

    const days = Math.max(1, parseInt(num_days, 10) || 1);
    const dist = Math.max(1, parseInt(estimated_km, 10) || 0);

    const minAllowedKm = rateCard.min_km_per_day * days;
    const billableKm = Math.max(dist, minAllowedKm);
    
    const kmCost = billableKm * rateCard.per_km_rate;
    const totalDriverBatta = rateCard.driver_batta_per_day * days;
    const nightCharge = is_night_trip ? rateCard.night_charge : 0.0;

    const totalAmount = kmCost + totalDriverBatta + nightCharge;

    return {
        vehicle_type: rateCard.vehicle_type,
        per_km_rate: rateCard.per_km_rate,
        min_km_per_day: rateCard.min_km_per_day,
        num_days: days,
        estimated_km: dist,
        billable_km: billableKm,
        km_cost: kmCost,
        driver_batta_per_day: rateCard.driver_batta_per_day,
        total_driver_batta: totalDriverBatta,
        night_charge: nightCharge,
        is_night_trip: !!is_night_trip,
        total_amount: totalAmount,
        breakdown_text: `*Flying Eagle Trip Quote* 🚕\n` +
            `• Vehicle: ${rateCard.vehicle_type}\n` +
            `• Estimated Distance: ${dist} KM (Min Billed: ${billableKm} KM @ ₹${rateCard.per_km_rate}/KM)\n` +
            `• Duration: ${days} Day(s)\n` +
            `• Base Fare: ₹${kmCost.toLocaleString('en-IN')}\n` +
            `• Driver Batta: ₹${totalDriverBatta.toLocaleString('en-IN')} (₹${rateCard.driver_batta_per_day}/day)\n` +
            (nightCharge > 0 ? `• Night Charge: ₹${nightCharge.toLocaleString('en-IN')}\n` : '') +
            `-----------------------------------\n` +
            `*Estimated Total: ₹${totalAmount.toLocaleString('en-IN')}*\n` +
            `_(Excludes Toll, Parking & State Permitting Charges)_`
    };
}

module.exports = {
    calculateTariff
};
