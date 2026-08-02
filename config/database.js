const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'fleetlink.db');
const db = new Database(dbPath);

// Enable WAL mode for high performance
db.pragma('journal_mode = WAL');

function initDatabase() {
    // 1. Rate Cards Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS rate_cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_type TEXT NOT NULL UNIQUE,
            per_km_rate REAL NOT NULL,
            min_km_per_day INTEGER NOT NULL DEFAULT 250,
            driver_batta_per_day REAL NOT NULL,
            night_charge REAL DEFAULT 0.0,
            description TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Migration: add description column for databases created before this field existed
    const rateCardCols = db.prepare(`PRAGMA table_info(rate_cards)`).all();
    if (!rateCardCols.some(c => c.name === 'description')) {
        db.exec(`ALTER TABLE rate_cards ADD COLUMN description TEXT DEFAULT ''`);
    }

    // Seed default rate cards if empty
    const rateCardCount = db.prepare('SELECT COUNT(*) as count FROM rate_cards').get();
    if (rateCardCount.count === 0) {
        const insertRateCard = db.prepare(`
            INSERT INTO rate_cards (vehicle_type, per_km_rate, min_km_per_day, driver_batta_per_day, night_charge, description)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        insertRateCard.run('Sedan (Dzire/Etios)', 13.0, 250, 400.0, 300.0, 'Comfortable 4-seater, ideal for solo/couple outstation trips.');
        insertRateCard.run('SUV (Ertiga)', 17.0, 250, 500.0, 400.0, '6-seater SUV, good for small families with luggage.');
        insertRateCard.run('Premium SUV (Innova Crysta)', 21.0, 250, 600.0, 500.0, 'Spacious 7-seater, best for longer trips and larger groups.');
        insertRateCard.run('Tempo Traveller (12 Seater)', 26.0, 300, 800.0, 600.0, '12-seater van, suited for group travel and outings.');
    }

    // 2. Partners & Internal Fleet Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS partners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
            is_internal INTEGER DEFAULT 0,
            vehicles_offered TEXT NOT NULL, -- JSON array string
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Seed sample partners if empty
    const partnerCount = db.prepare('SELECT COUNT(*) as count FROM partners').get();
    if (partnerCount.count === 0) {
        const insertPartner = db.prepare(`
            INSERT INTO partners (name, phone, is_internal, vehicles_offered, is_active)
            VALUES (?, ?, ?, ?, ?)
        `);
        insertPartner.run('Own Fleet (Primary)', '+919876543210', 1, JSON.stringify(['Sedan (Dzire/Etios)', 'SUV (Ertiga)', 'Premium SUV (Innova Crysta)']), 1);
        insertPartner.run('Kavitha Travels (Tie-up)', '+919123456789', 0, JSON.stringify(['Sedan (Dzire/Etios)', 'SUV (Ertiga)']), 1);
        insertPartner.run('Sri Murugan Cabs (Tie-up)', '+919988776655', 0, JSON.stringify(['Premium SUV (Innova Crysta)', 'Tempo Traveller (12 Seater)']), 1);
        insertPartner.run('Royal Outstation Cabs (Tie-up)', '+919443322110', 0, JSON.stringify(['Sedan (Dzire/Etios)', 'Premium SUV (Innova Crysta)']), 1);
    }

    // 2b. Partner Availability Table - rolling current status per partner, upserted
    // whenever a partner reports (no scheduled prompts; partners update anytime).
    db.exec(`
        CREATE TABLE IF NOT EXISTS partner_availability (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            partner_id INTEGER NOT NULL UNIQUE,
            is_available INTEGER NOT NULL DEFAULT 1,
            vehicle_type TEXT,
            vehicle_number TEXT,
            location TEXT,
            location_lat REAL,
            location_lon REAL,
            reported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (partner_id) REFERENCES partners(id)
        );
    `);

    // 3. Bookings Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_code TEXT UNIQUE NOT NULL,
            customer_name TEXT NOT NULL,
            customer_phone TEXT NOT NULL,
            pickup_location TEXT NOT NULL,
            drop_location TEXT NOT NULL,
            trip_start_date TEXT NOT NULL,
            trip_end_date TEXT NOT NULL,
            num_days INTEGER NOT NULL DEFAULT 1,
            estimated_km INTEGER NOT NULL,
            vehicle_type TEXT NOT NULL,
            calculated_amount REAL NOT NULL,
            status TEXT DEFAULT 'PENDING',
            assigned_partner_id INTEGER,
            driver_name TEXT,
            driver_phone TEXT,
            vehicle_number TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (assigned_partner_id) REFERENCES partners(id)
        );
    `);

    // Seed sample booking if empty
    const bookingCount = db.prepare('SELECT COUNT(*) as count FROM bookings').get();
    if (bookingCount.count === 0) {
        const insertBooking = db.prepare(`
            INSERT INTO bookings (booking_code, customer_name, customer_phone, pickup_location, drop_location, trip_start_date, trip_end_date, num_days, estimated_km, vehicle_type, calculated_amount, status, assigned_partner_id, driver_name, driver_phone, vehicle_number)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertBooking.run(
            'FL-2026-101',
            'Ramesh Kumar',
            '+919840011223',
            'Chennai Airport (MAA)',
            'Madurai Junction',
            '2026-08-05T06:00',
            '2026-08-07T21:00',
            3,
            950,
            'Premium SUV (Innova Crysta)',
            21750.00,
            'CONFIRMED',
            1,
            'Senthil Kumar',
            '+919789012345',
            'TN 09 CB 4567'
        );
    }

    console.log('[Database] SQLite initialized with tables and seed data.');
}

initDatabase();

module.exports = db;
