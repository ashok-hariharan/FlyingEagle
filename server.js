try {
    require('dotenv').config();
} catch (e) {
    console.log('[Info] Using default environment configuration.');
}
const express = require('express');
const cors = require('cors');
const path = require('path');

const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files for single-page Admin Dashboard
app.use(express.static(path.join(__dirname, 'public')));

// Mount routes
app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);

// Fallback to index.html for SPA routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`=======================================================`);
    console.log(`🚕 FleetLink WhatsApp Engine & Operations Dashboard`);
    console.log(`📍 Running locally at: http://127.0.0.1:${PORT}`);
    console.log(`📲 Meta Webhook Endpoint: http://127.0.0.1:${PORT}/webhook/whatsapp`);
    console.log(`=======================================================`);
});
