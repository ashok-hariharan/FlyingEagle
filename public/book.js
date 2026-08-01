// FleetLink Customer Self-Service Trip Request Page

document.addEventListener('DOMContentLoaded', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    document.getElementById('req-start').value = tomorrow.toISOString().slice(0, 16);
});

function collectPayload() {
    return {
        customer_name: document.getElementById('req-name').value,
        customer_phone: document.getElementById('req-phone').value,
        pickup_location: document.getElementById('req-pickup').value,
        drop_location: document.getElementById('req-drop').value,
        trip_start_date: document.getElementById('req-start').value,
        num_days: parseInt(document.getElementById('req-days').value, 10),
        vehicle_type: document.getElementById('req-vehicle').value,
        estimated_km: parseInt(document.getElementById('req-km').value, 10)
    };
}

async function previewQuote() {
    const errorEl = document.getElementById('request-error');
    const previewEl = document.getElementById('quote-preview');
    errorEl.classList.add('hidden');

    const payload = collectPayload();
    if (!payload.vehicle_type || !payload.estimated_km || !payload.num_days) {
        errorEl.textContent = 'Please fill in vehicle, distance & duration first.';
        errorEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch('/api/quick-quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vehicle_type: payload.vehicle_type,
                estimated_km: payload.estimated_km,
                num_days: payload.num_days
            })
        });
        const data = await res.json();
        if (data.success) {
            previewEl.textContent = data.quote.breakdown_text;
            previewEl.classList.remove('hidden');
        } else {
            errorEl.textContent = data.error || 'Could not calculate a quote.';
            errorEl.classList.remove('hidden');
        }
    } catch (err) {
        errorEl.textContent = 'Error calculating fare. Please try again.';
        errorEl.classList.remove('hidden');
    }
}

async function submitRequest(e) {
    e.preventDefault();
    const errorEl = document.getElementById('request-error');
    errorEl.classList.add('hidden');

    const payload = { ...collectPayload(), notes: 'Submitted via Customer Web Portal' };

    try {
        const res = await fetch('/api/bookings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('request-panel').classList.add('hidden');
            document.getElementById('success-panel').classList.remove('hidden');
            document.getElementById('success-ref').textContent = data.booking.booking_code;
        } else {
            errorEl.textContent = data.error || 'Could not submit your request. Please check your details.';
            errorEl.classList.remove('hidden');
        }
    } catch (err) {
        errorEl.textContent = 'Network error. Please try again.';
        errorEl.classList.remove('hidden');
    }
}

function resetForm() {
    document.getElementById('request-form').reset();
    document.getElementById('quote-preview').classList.add('hidden');
    document.getElementById('request-error').classList.add('hidden');
    document.getElementById('success-panel').classList.add('hidden');
    document.getElementById('request-panel').classList.remove('hidden');

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    document.getElementById('req-start').value = tomorrow.toISOString().slice(0, 16);
    document.getElementById('req-days').value = 1;
    document.getElementById('req-km').value = 300;
}
