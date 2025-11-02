// server.js
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const cors = require("cors");
const { assignDriverForBooking } = require("./assigner");
const { runRebalancer } = require("./rebalancer");

// === CONFIG / INIT ===
// Point this to your service account JSON path or set GOOGLE_APPLICATION_CREDENTIALS env var.
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();
app.use(bodyParser.json());
app.use(cors());

// Simple health check
app.get("/", (req, res) => res.send("Dropee assignment server running"));

// Webhook: create booking + assign immediately
// (Use this if you want to POST new bookings here instead of writing directly to Firestore)
app.post("/booking", async (req, res) => {
  try {
    const booking = req.body;
    if (!booking || !booking.pickup || !booking.number) {
      return res.status(400).json({ error: "invalid booking payload" });
    }

    // add timestamp & default fields
    const newBooking = {
      ...booking,
      status: booking.status || "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection("bookings").add(newBooking);
    const bookingId = ref.id;

    // attempt to assign immediately (best-effort)
    assignDriverForBooking(admin, bookingId).catch((err) => {
      console.error("assigner error:", err.message);
    });

    res.json({ bookingId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Optionally run the continuous listener for new bookings with status == 'pending'
function startBookingListener() {
  console.log("Starting Firestore bookings listener...");
  const bookingsQuery = db.collection("bookings").where("status", "==", "pending");

  bookingsQuery.onSnapshot((snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") {
        const bookingId = change.doc.id;
        console.log("New pending booking:", bookingId);
        assignDriverForBooking(admin, bookingId).catch((err) => {
          console.error("assigner error:", err.message);
        });
      }
    });
  }, (err) => {
    console.error("Listener error:", err);
  });
}

// Choose whether to start the listener:
const ENABLE_LISTENER = true;
if (ENABLE_LISTENER) startBookingListener();

// Add endpoint to manually trigger rebalancer
app.post("/rebalance", async (req, res) => {
  try {
    const autoApply = req.body.autoApply === true;
    const suggestions = await runRebalancer(admin, autoApply);
    res.json({ success: true, suggestions });
  } catch (err) {
    console.error("Rebalancer error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Start periodic rebalancer
function startPeriodicRebalancer() {
  console.log("Starting periodic rebalancer...");
  
  // Run rebalancer every 5 minutes
  const REBALANCE_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
  
  // Run immediately on startup
  runRebalancer(admin, true).catch(err => {
    console.error("Rebalancer error:", err);
  });
  
  // Then run periodically
  setInterval(() => {
    runRebalancer(admin, true).catch(err => {
      console.error("Rebalancer error:", err);
    });
  }, REBALANCE_INTERVAL);
}

// Enable periodic rebalancer
const ENABLE_REBALANCER = true;
if (ENABLE_REBALANCER) startPeriodicRebalancer();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on ${PORT}`));
