// Flying Eagle Admin Operations Dashboard Controller

let currentBookings = [];
let currentPartners = [];
let currentRateCards = [];

document.addEventListener('DOMContentLoaded', () => {
    populateVehicleDropdowns().then(() => {
        loadBookings();
        loadPartners();
    });
    loadRateCards();
    pollWhatsAppStatus();
    setInterval(pollWhatsAppStatus, 3000);
});

// Populates every vehicle-type dropdown/checklist in the app from the live rate card
// catalog, so a newly-added vehicle type is immediately selectable everywhere.
async function populateVehicleDropdowns() {
    try {
        const res = await fetch('/api/rate-cards');
        const data = await res.json();
        if (!data.success) return;

        currentRateCards = data.rateCards;

        const calcSelect = document.getElementById('calc-vehicle');
        const bookSelect = document.getElementById('book-vehicle');
        const partnerChecklist = document.getElementById('partner-vehicles-list');

        if (calcSelect) {
            calcSelect.innerHTML = data.rateCards.map(rc =>
                `<option value="${escapeHtml(rc.vehicle_type)}">${escapeHtml(rc.vehicle_type)}</option>`
            ).join('');
        }
        if (bookSelect) {
            bookSelect.innerHTML = data.rateCards.map(rc =>
                `<option value="${escapeHtml(rc.vehicle_type)}">${escapeHtml(rc.vehicle_type)}</option>`
            ).join('');
        }
        if (partnerChecklist) {
            partnerChecklist.innerHTML = data.rateCards.map(rc =>
                `<label><input type="checkbox" name="partner-vehicles" value="${escapeHtml(rc.vehicle_type)}" checked> ${escapeHtml(rc.vehicle_type)}</label>`
            ).join('');
        }
    } catch (err) {
        console.error('Error populating vehicle dropdowns:', err);
    }
}

// Tab Switcher
function switchTab(tabId) {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    const activeTabBtn = document.querySelector(`.nav-tab[onclick="switchTab('${tabId}')"]`);
    const activeContent = document.getElementById(`tab-${tabId}`);

    if (activeTabBtn) activeTabBtn.classList.add('active');
    if (activeContent) activeContent.classList.add('active');
}

// Modal Helpers
function openModal(id) {
    document.getElementById(id).classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

function openNewBookingModal() {
    document.getElementById('book-id').value = '';
    document.getElementById('modal-booking-title').textContent = 'New Outstation Booking';
    document.getElementById('modal-booking-submit').textContent = 'Create & Send WhatsApp Quote';

    // Set default trip start to tomorrow 6 AM
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(6, 0, 0, 0);
    document.getElementById('book-name').value = '';
    document.getElementById('book-phone').value = '';
    document.getElementById('book-pickup').value = '';
    document.getElementById('book-drop').value = '';
    document.getElementById('book-start').value = tomorrow.toISOString().slice(0, 16);
    document.getElementById('book-days').value = 2;
    document.getElementById('book-vehicle').value = 'Sedan (Dzire/Etios)';
    document.getElementById('book-km').value = 500;
    openModal('modal-booking');
}

function openEditBookingModal(bookingId) {
    const b = currentBookings.find(x => x.id === bookingId);
    if (!b) return;

    document.getElementById('book-id').value = b.id;
    document.getElementById('modal-booking-title').textContent = `Edit Booking ${b.booking_code}`;
    document.getElementById('modal-booking-submit').textContent = 'Save Changes';

    document.getElementById('book-name').value = b.customer_name;
    document.getElementById('book-phone').value = b.customer_phone;
    document.getElementById('book-pickup').value = b.pickup_location;
    document.getElementById('book-drop').value = b.drop_location;
    document.getElementById('book-start').value = b.trip_start_date ? b.trip_start_date.slice(0, 16) : '';
    document.getElementById('book-days').value = b.num_days;
    document.getElementById('book-vehicle').value = b.vehicle_type;
    document.getElementById('book-km').value = b.estimated_km;

    openModal('modal-booking');
}

async function deleteBooking(bookingId, bookingCode) {
    if (!confirm(`Delete booking ${bookingCode}? This cannot be undone.`)) return;

    try {
        const res = await fetch(`/api/bookings/${bookingId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            loadBookings();
        } else {
            alert(`⚠️ ${data.error || 'Failed to delete booking.'}`);
        }
    } catch (err) {
        alert('Error deleting booking.');
    }
}

function openNewPartnerModal() {
    document.getElementById('partner-id').value = '';
    document.getElementById('modal-partner-title').textContent = 'Add Tie-up Travel Partner';
    document.getElementById('modal-partner-submit').textContent = 'Save Partner';

    document.getElementById('partner-name').value = '';
    document.getElementById('partner-phone').value = '';
    document.querySelectorAll('input[name="partner-vehicles"]').forEach(cb => {
        cb.checked = cb.value !== 'Tempo Traveller (12 Seater)';
    });
    openModal('modal-partner');
}

function openEditPartnerModal(partnerId) {
    const p = currentPartners.find(x => x.id === partnerId);
    if (!p) return;

    document.getElementById('partner-id').value = p.id;
    document.getElementById('modal-partner-title').textContent = `Edit Partner: ${p.name}`;
    document.getElementById('modal-partner-submit').textContent = 'Save Changes';

    document.getElementById('partner-name').value = p.name;
    document.getElementById('partner-phone').value = p.phone;
    document.querySelectorAll('input[name="partner-vehicles"]').forEach(cb => {
        cb.checked = p.vehicles_offered.includes(cb.value);
    });
    openModal('modal-partner');
}

async function deletePartner(partnerId, partnerName) {
    if (!confirm(`Delete partner "${partnerName}"? This cannot be undone.`)) return;

    try {
        const res = await fetch(`/api/partners/${partnerId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            loadPartners();
        } else {
            alert(`⚠️ ${data.error || 'Failed to delete partner.'}`);
        }
    } catch (err) {
        alert('Error deleting partner.');
    }
}

function openDispatchModal(bookingId) {
    document.getElementById('dispatch-booking-id').value = bookingId;

    // Pre-fill with the last driver/vehicle used for this booking's partner, if we have one
    const b = currentBookings.find(x => x.id === bookingId);
    document.getElementById('dispatch-driver-name').value = (b && b.last_driver_name) || '';
    document.getElementById('dispatch-driver-phone').value = (b && b.last_driver_phone) || '';
    document.getElementById('dispatch-vehicle-number').value = (b && b.last_vehicle_number) || '';

    openModal('modal-dispatch');
}

// One-click send using the last known driver/vehicle for this booking's partner -
// skips the modal entirely when we already have the details on file.
async function sendLastKnownDriver(bookingId) {
    const b = currentBookings.find(x => x.id === bookingId);
    if (!b || !b.last_driver_name) {
        alert('No known driver details found for this partner.');
        return;
    }

    if (!confirm(`Send trip card to customer with:\nDriver: ${b.last_driver_name}\nPhone: ${b.last_driver_phone}\nVehicle: ${b.last_vehicle_number}?`)) return;

    try {
        const res = await fetch(`/api/bookings/${bookingId}/dispatch-driver`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                driver_name: b.last_driver_name,
                driver_phone: b.last_driver_phone,
                vehicle_number: b.last_vehicle_number
            })
        });
        const data = await res.json();
        if (data.success) {
            alert('✅ Driver details & Trip Card sent to Customer over WhatsApp!');
            loadBookings();
        } else {
            alert(`⚠️ ${data.error || 'Failed to send driver details.'}`);
        }
    } catch (err) {
        alert('Error sending driver details.');
    }
}

// 1. Load Bookings
async function loadBookings() {
    try {
        const res = await fetch('/api/bookings');
        const data = await res.json();

        if (!data.success) return;

        currentBookings = data.bookings;

        const listEl = document.getElementById('bookings-list');
        const countEl = document.getElementById('booking-count');
        countEl.textContent = `${data.bookings.length} Booking(s)`;

        if (data.bookings.length === 0) {
            listEl.innerHTML = `<p style="color: var(--text-muted);">No bookings yet. Click '+ New Trip Booking' to create one.</p>`;
            return;
        }

        listEl.innerHTML = data.bookings.map(b => `
            <div class="card">
                <div class="card-header">
                    <span class="booking-code">${b.booking_code}</span>
                    <span class="status-badge status-${b.status}">${formatStatus(b.status)}</span>
                </div>
                <div class="card-body">
                    <div class="route-info">📍 ${escapeHtml(b.pickup_location)} ➔ ${escapeHtml(b.drop_location)}</div>
                    <div>👤 <strong>${escapeHtml(b.customer_name)}</strong> (${escapeHtml(b.customer_phone)})</div>
                    <div>🚕 <strong>Vehicle:</strong> ${escapeHtml(b.vehicle_type)}</div>
                    <div>📅 <strong>Start:</strong> ${new Date(b.trip_start_date).toLocaleString()} (${b.num_days} Days)</div>
                    <div>🛣️ <strong>Estimated KM:</strong> ${b.estimated_km} KM</div>
                    <div class="fare-tag">₹${b.calculated_amount.toLocaleString('en-IN')}</div>
                    ${b.partner_name ? `<div>🤝 <strong>Assigned Partner:</strong> ${escapeHtml(b.partner_name)}</div>` : ''}
                    ${b.driver_name ? `<div>🚘 <strong>Driver:</strong> ${escapeHtml(b.driver_name)} (${escapeHtml(b.driver_phone)}) | Reg: ${escapeHtml(b.vehicle_number)}</div>` : ''}
                    ${renderSourceTag(b.notes)}
                </div>
                <div class="card-footer">
                    ${renderCardActions(b)}
                    <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
                        <button class="btn btn-secondary btn-full" onclick="openEditBookingModal(${b.id})">✏️ Edit</button>
                        <button class="btn btn-danger btn-full" onclick="deleteBooking(${b.id}, '${escapeHtml(b.booking_code)}')">🗑️ Delete</button>
                    </div>
                </div>
            </div>
        `).join('');

    } catch (err) {
        console.error('Failed to load bookings:', err);
    }
}

function renderCardActions(b) {
    if (b.status === 'PENDING') {
        return `
            <button class="btn btn-secondary btn-full" onclick="broadcastPartnerWhatsApp(${b.id})">
                📲 Broadcast to Partners (WhatsApp)
            </button>
            <button class="btn btn-primary btn-full" onclick="quickAssignInternalFleet(${b.id})">
                🚗 Assign Internal Fleet
            </button>
        `;
    }
    if (b.status === 'INTERNAL_OFFERED') {
        return `
            <div style="display:flex; gap:0.5rem;">
                <button class="btn btn-primary btn-full" onclick="acceptOwnFleet(${b.id})">
                    ✅ Accept for Own Fleet
                </button>
                <button class="btn btn-secondary btn-full" onclick="declineOwnFleet(${b.id})">
                    ❌ Decline (Send to Partners)
                </button>
            </div>
        `;
    }
    if (b.status === 'PARTNER_BROADCAST') {
        return `
            <button class="btn btn-secondary btn-full" disabled>
                ⏳ Waiting for Partner WhatsApp Acceptance...
            </button>
        `;
    }
    if (b.status === 'ASSIGNED' || b.status === 'CONFIRMED') {
        if (b.last_driver_name) {
            return `
                <div style="display:flex; gap:0.5rem;">
                    <button class="btn btn-accent btn-full" onclick="sendLastKnownDriver(${b.id})">
                        ⚡ Send ${escapeHtml(b.last_driver_name)} Instantly
                    </button>
                    <button class="btn btn-secondary btn-full" onclick="openDispatchModal(${b.id})">
                        ✏️ Different Driver
                    </button>
                </div>
            `;
        }
        return `
            <button class="btn btn-accent btn-full" onclick="openDispatchModal(${b.id})">
                📲 Dispatch Driver Card (T-4 Hours)
            </button>
        `;
    }
    if (b.status === 'IN_PROGRESS') {
        return `
            <button class="btn btn-secondary btn-full" disabled>
                🟢 Trip In Progress
            </button>
        `;
    }
    return '';
}

function renderSourceTag(notes) {
    if (!notes) return '';
    if (notes.includes('WhatsApp Bot')) {
        return `<div style="margin-top:0.3rem;"><span class="status-badge status-CONFIRMED">📱 Self-booked via WhatsApp</span></div>`;
    }
    if (notes.includes('Customer Web Portal')) {
        return `<div style="margin-top:0.3rem;"><span class="status-badge status-CONFIRMED">🌐 Self-booked via Web</span></div>`;
    }
    return '';
}

function formatStatus(status) {
    switch (status) {
        case 'PENDING': return 'Pending Quote';
        case 'INTERNAL_OFFERED': return 'Offered to Own Fleet';
        case 'PARTNER_BROADCAST': return 'Partner Broadcast Sent';
        case 'ASSIGNED': return 'Partner Assigned';
        case 'CONFIRMED': return 'Confirmed';
        case 'IN_PROGRESS': return 'Trip In Progress';
        case 'COMPLETED': return 'Completed';
        default: return status;
    }
}

// 2. Trigger WhatsApp Partner Broadcast
async function broadcastPartnerWhatsApp(bookingId) {
    if (!confirm('Broadcast this trip details & interactive accept button to all tie-up travel partners over WhatsApp?')) return;

    try {
        const res = await fetch(`/api/bookings/${bookingId}/broadcast`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert(`✅ Successfully broadcasted trip to ${data.count} tie-up partner(s) over WhatsApp!`);
            loadBookings();
        } else {
            alert(`⚠️ Broadcast notice: ${data.message || 'No partners notified.'}`);
        }
    } catch (err) {
        alert('Error triggering WhatsApp broadcast.');
    }
}

// 3. Quick Assign Internal Fleet
async function quickAssignInternalFleet(bookingId) {
    try {
        const res = await fetch(`/api/bookings/${bookingId}/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ partner_id: 1 }) // ID 1 is Internal Fleet
        });
        const data = await res.json();
        if (data.success) {
            alert('✅ Trip assigned to Internal Fleet & WhatsApp confirmation sent!');
            loadBookings();
        }
    } catch (err) {
        alert('Failed to assign internal fleet.');
    }
}

// Accept/Decline an own-fleet first-refusal offer directly from the dashboard
// (doesn't rely on a WhatsApp reply, since the fleet's own number often can't message itself)
async function acceptOwnFleet(bookingId) {
    try {
        const res = await fetch(`/api/bookings/${bookingId}/accept-internal`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert('✅ Trip assigned to Own Fleet & WhatsApp confirmation sent!');
            loadBookings();
        } else {
            alert(`⚠️ ${data.error || 'Failed to accept for own fleet.'}`);
        }
    } catch (err) {
        alert('Error accepting for own fleet.');
    }
}

async function declineOwnFleet(bookingId) {
    if (!confirm('Release this trip to tie-up partners instead of own fleet?')) return;

    try {
        const res = await fetch(`/api/bookings/${bookingId}/decline-internal`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert(`✅ Released to tie-up partners! Broadcast sent to ${data.count} partner(s).`);
            loadBookings();
        } else {
            alert(`⚠️ ${data.message || data.error || 'No eligible tie-up partners found.'}`);
        }
    } catch (err) {
        alert('Error declining own fleet offer.');
    }
}

// 4. Dispatch Driver Info (T-4h)
async function dispatchDriver(e) {
    e.preventDefault();
    const bookingId = document.getElementById('dispatch-booking-id').value;
    const driver_name = document.getElementById('dispatch-driver-name').value;
    const driver_phone = document.getElementById('dispatch-driver-phone').value;
    const vehicle_number = document.getElementById('dispatch-vehicle-number').value;

    try {
        const res = await fetch(`/api/bookings/${bookingId}/dispatch-driver`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ driver_name, driver_phone, vehicle_number })
        });
        const data = await res.json();
        if (data.success) {
            alert('✅ Driver details & Trip Card sent to Customer over WhatsApp!');
            closeModal('modal-dispatch');
            loadBookings();
        }
    } catch (err) {
        alert('Error dispatching driver details.');
    }
}

// 5. Create / Edit Booking Form Handler
async function saveBooking(e) {
    e.preventDefault();
    const bookingId = document.getElementById('book-id').value;
    const payload = {
        customer_name: document.getElementById('book-name').value,
        customer_phone: document.getElementById('book-phone').value,
        pickup_location: document.getElementById('book-pickup').value,
        drop_location: document.getElementById('book-drop').value,
        trip_start_date: document.getElementById('book-start').value,
        num_days: parseInt(document.getElementById('book-days').value, 10),
        vehicle_type: document.getElementById('book-vehicle').value,
        estimated_km: parseInt(document.getElementById('book-km').value, 10)
    };

    try {
        const res = bookingId
            ? await fetch(`/api/bookings/${bookingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            : await fetch('/api/bookings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        const data = await res.json();
        if (data.success) {
            alert(bookingId
                ? `✅ Booking ${data.booking.booking_code} updated!`
                : `✅ Booking ${data.booking.booking_code} created! Fare breakdown sent to customer WhatsApp.`);
            closeModal('modal-booking');
            loadBookings();
        } else {
            alert(`⚠️ ${data.error || 'Failed to save booking.'}`);
        }
    } catch (err) {
        alert('Failed to save booking.');
    }
}

// 6. Quick Calculator Desk
async function calculateQuote(e) {
    e.preventDefault();
    const payload = {
        vehicle_type: document.getElementById('calc-vehicle').value,
        estimated_km: parseInt(document.getElementById('calc-km').value, 10),
        num_days: parseInt(document.getElementById('calc-days').value, 10),
        is_night_trip: document.getElementById('calc-night').checked
    };

    try {
        const res = await fetch('/api/quick-quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            const box = document.getElementById('calc-result');
            box.textContent = data.quote.breakdown_text;
            box.classList.remove('hidden');
        }
    } catch (err) {
        alert('Error calculating fare.');
    }
}

// 7. Load Rate Cards Table
async function loadRateCards() {
    try {
        const res = await fetch('/api/rate-cards');
        const data = await res.json();
        if (!data.success) return;

        currentRateCards = data.rateCards;

        const tbody = document.getElementById('rate-cards-tbody');
        tbody.innerHTML = data.rateCards.map(rc => `
            <tr>
                <td><strong>${escapeHtml(rc.vehicle_type)}</strong></td>
                <td><input type="text" id="rate-desc-${rc.id}" class="form-control" value="${escapeHtml(rc.description || '')}" style="width: 200px;" placeholder="Description"></td>
                <td><input type="number" step="0.5" id="rate-km-${rc.id}" class="form-control" value="${rc.per_km_rate}" style="width: 100px;"></td>
                <td><input type="number" id="rate-minkm-${rc.id}" class="form-control" value="${rc.min_km_per_day}" style="width: 100px;"></td>
                <td><input type="number" id="rate-batta-${rc.id}" class="form-control" value="${rc.driver_batta_per_day}" style="width: 110px;"></td>
                <td><input type="number" id="rate-night-${rc.id}" class="form-control" value="${rc.night_charge}" style="width: 100px;"></td>
                <td style="display:flex; gap:0.4rem;">
                    <button class="btn btn-secondary" onclick="updateRateCard(${rc.id})">Save Rate</button>
                    <button class="btn btn-danger" onclick="deleteRateCard(${rc.id}, '${escapeHtml(rc.vehicle_type)}')">🗑️ Delete</button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        console.error('Error loading rate cards:', err);
    }
}

function openNewVehicleTypeModal() {
    document.getElementById('vt-name').value = '';
    document.getElementById('vt-description').value = '';
    document.getElementById('vt-per-km').value = '';
    document.getElementById('vt-min-km').value = 250;
    document.getElementById('vt-batta').value = '';
    document.getElementById('vt-night').value = 0;
    openModal('modal-vehicle-type');
}

async function saveNewVehicleType(e) {
    e.preventDefault();
    const payload = {
        vehicle_type: document.getElementById('vt-name').value,
        description: document.getElementById('vt-description').value,
        per_km_rate: parseFloat(document.getElementById('vt-per-km').value),
        min_km_per_day: parseInt(document.getElementById('vt-min-km').value, 10),
        driver_batta_per_day: parseFloat(document.getElementById('vt-batta').value),
        night_charge: parseFloat(document.getElementById('vt-night').value) || 0
    };

    try {
        const res = await fetch('/api/rate-cards', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            alert(`✅ Vehicle type "${data.rateCard.vehicle_type}" added! It's now selectable everywhere.`);
            closeModal('modal-vehicle-type');
            loadRateCards();
            populateVehicleDropdowns();
        } else {
            alert(`⚠️ ${data.error || 'Failed to add vehicle type.'}`);
        }
    } catch (err) {
        alert('Error adding vehicle type.');
    }
}

async function deleteRateCard(id, vehicleType) {
    if (!confirm(`Delete the rate card for "${vehicleType}"? Bookings and quotes for this vehicle type will no longer be possible.`)) return;

    try {
        const res = await fetch(`/api/rate-cards/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            loadRateCards();
            populateVehicleDropdowns();
        } else {
            alert(`⚠️ ${data.error || 'Failed to delete rate card.'}`);
        }
    } catch (err) {
        alert('Error deleting rate card.');
    }
}

async function updateRateCard(id) {
    const payload = {
        description: document.getElementById(`rate-desc-${id}`).value,
        per_km_rate: parseFloat(document.getElementById(`rate-km-${id}`).value),
        min_km_per_day: parseInt(document.getElementById(`rate-minkm-${id}`).value, 10),
        driver_batta_per_day: parseFloat(document.getElementById(`rate-batta-${id}`).value),
        night_charge: parseFloat(document.getElementById(`rate-night-${id}`).value)
    };

    try {
        const res = await fetch(`/api/rate-cards/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            alert('✅ Rate card updated successfully!');
            loadRateCards();
        }
    } catch (err) {
        alert('Failed to update rate card.');
    }
}

// 8. Load Partners Directory
function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diffMs = Date.now() - new Date(dateStr.replace(' ', 'T') + 'Z').getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function renderAvailabilityStatus(p) {
    if (p.is_available === null || p.is_available === undefined) {
        return `<span class="status-badge status-PENDING">⚪ No availability reported</span>`;
    }
    if (p.is_available) {
        const details = [
            p.available_vehicle_type,
            p.available_location ? `@ ${p.available_location}` : null
        ].filter(Boolean).join(' ');
        return `<span class="status-badge status-CONFIRMED">🟢 Available${details ? ': ' + escapeHtml(details) : ''}</span> ` +
            `<span style="font-size:0.75rem; color: var(--text-muted);">${timeAgo(p.availability_reported_at)}</span>`;
    }
    return `<span class="status-badge status-INTERNAL_OFFERED">🔴 Unavailable</span> ` +
        `<span style="font-size:0.75rem; color: var(--text-muted);">${timeAgo(p.availability_reported_at)}</span>`;
}

async function loadPartners() {
    try {
        const res = await fetch('/api/partners');
        const data = await res.json();
        if (!data.success) return;

        currentPartners = data.partners;

        const list = document.getElementById('partners-list');
        list.innerHTML = data.partners.map(p => `
            <div class="card">
                <div class="card-header">
                    <span class="booking-code">${escapeHtml(p.name)} ${p.is_internal ? '⭐ (Own Fleet)' : ''}</span>
                </div>
                <div class="card-body">
                    <div>📱 <strong>WhatsApp:</strong> ${escapeHtml(p.phone)}</div>
                    <div>🚕 <strong>Vehicles Offered:</strong></div>
                    <div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin-top:0.3rem;">
                        ${p.vehicles_offered.map(v => `<span class="status-badge status-CONFIRMED">${escapeHtml(v)}</span>`).join('')}
                    </div>
                    <div style="margin-top:0.5rem;">${renderAvailabilityStatus(p)}</div>
                </div>
                <div class="card-footer">
                    <div style="display:flex; gap:0.5rem;">
                        <button class="btn btn-secondary btn-full" onclick="openEditPartnerModal(${p.id})">✏️ Edit</button>
                        <button class="btn btn-danger btn-full" onclick="deletePartner(${p.id}, '${escapeHtml(p.name)}')">🗑️ Delete</button>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('Error loading partners:', err);
    }
}

async function savePartner(e) {
    e.preventDefault();
    const partnerId = document.getElementById('partner-id').value;
    const existing = partnerId ? currentPartners.find(p => p.id === parseInt(partnerId, 10)) : null;
    const selectedVehicles = Array.from(document.querySelectorAll('input[name="partner-vehicles"]:checked')).map(cb => cb.value);
    const payload = {
        name: document.getElementById('partner-name').value,
        phone: document.getElementById('partner-phone').value,
        is_internal: existing ? !!existing.is_internal : false,
        vehicles_offered: selectedVehicles
    };

    try {
        const res = partnerId
            ? await fetch(`/api/partners/${partnerId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            : await fetch('/api/partners', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        const data = await res.json();
        if (data.success) {
            alert(partnerId ? '✅ Partner updated!' : '✅ Tie-up partner added!');
            closeModal('modal-partner');
            loadPartners();
        } else {
            alert(`⚠️ ${data.error || 'Failed to save partner.'}`);
        }
    } catch (err) {
        alert('Error saving partner.');
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// WhatsApp Connection Status Poller
async function pollWhatsAppStatus() {
    try {
        const res = await fetch('/api/whatsapp/status');
        const data = await res.json();
        if (!data.success) return;

        const dot = document.getElementById('wa-status-dot');
        const text = document.getElementById('wa-status-text');
        const qrImg = document.getElementById('qr-code-img');
        const qrSpinner = document.getElementById('qr-spinner');
        const qrStatusMsg = document.getElementById('qr-status-msg');
        const scanInstructions = document.getElementById('qr-scan-instructions');
        const disconnectBtn = document.getElementById('wa-disconnect-btn');

        if (data.isConnected) {
            dot.textContent = '🟢';
            text.textContent = `WhatsApp Connected (${data.connectedUser || 'Active'})`;
            qrStatusMsg.textContent = `✅ Connected as +${data.connectedUser}`;
            qrSpinner.style.display = 'none';
            qrImg.style.display = 'none';
            scanInstructions.classList.add('hidden');
            disconnectBtn.classList.remove('hidden');
        } else {
            dot.textContent = data.qrDataURL ? '🔴' : '🟡';
            text.textContent = data.qrDataURL ? 'Scan QR Code to Connect' : 'Connecting WhatsApp...';
            qrStatusMsg.textContent = data.statusMessage || 'Scan QR Code below';
            scanInstructions.classList.remove('hidden');
            disconnectBtn.classList.add('hidden');

            if (data.qrDataURL) {
                qrSpinner.style.display = 'none';
                qrImg.src = data.qrDataURL;
                qrImg.style.display = 'block';
            } else {
                qrSpinner.style.display = 'block';
                qrImg.style.display = 'none';
            }
        }
    } catch (err) {
        console.error('Failed to poll WhatsApp status:', err);
    }
}

// Disconnect WhatsApp Web (unlinks the device; a fresh QR code appears afterward)
async function disconnectWhatsApp() {
    if (!confirm('Disconnect WhatsApp? The bot will stop sending/receiving messages until you scan a new QR code to reconnect.')) return;

    try {
        const res = await fetch('/api/whatsapp/disconnect', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            alert('🔌 WhatsApp disconnected. A new QR code will appear shortly.');
            pollWhatsAppStatus();
        } else {
            alert(`⚠️ ${data.error || 'Failed to disconnect WhatsApp.'}`);
        }
    } catch (err) {
        alert('Error disconnecting WhatsApp.');
    }
}

// Copy WhatsApp Customer Lead Link
async function copyWhatsAppLeadLink() {
    try {
        const res = await fetch('/api/whatsapp/status');
        const data = await res.json();
        const phone = data.connectedUser || '919876543210';
        const waUrl = `https://wa.me/${phone}?text=Hi,%20I%20want%20to%20book%20an%20outstation%20car`;

        await navigator.clipboard.writeText(waUrl);
        alert(`📋 Copied customer WhatsApp link:\n${waUrl}\n\nPaste this link on Google My Business, Instagram, or your website!`);
    } catch (err) {
        alert('Copied link!');
    }
}

// Copy Public Customer Web Booking Page Link
async function copyWebBookingLink() {
    const bookUrl = `${window.location.origin}/book.html`;
    try {
        await navigator.clipboard.writeText(bookUrl);
        alert(`🌐 Copied customer web booking link:\n${bookUrl}\n\nPaste this link on Google My Business, Instagram, or your website!`);
    } catch (err) {
        alert('Copied link!');
    }
}

