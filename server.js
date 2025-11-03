// server.js
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const cors = require("cors");
const { assignDriverForBooking } = require("./assigner");
const { runRebalancer } = require("./rebalancer");

// === FIREBASE INIT ===
// Use environment variable on Render, fallback to local file for development

let adminConfig;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Render or any cloud platform: JSON string stored in env var
  try {
    adminConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(adminConfig),
    });
    console.log("✅ Firebase initialized from environment variable");
  } catch (err) {
    console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT env var:", err);
    process.exit(1);
  }
} else {
  // Local dev: use serviceAccountKey.json file
  try {
    const serviceAccount = require("./serviceAccountKey.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase initialized from local serviceAccountKey.json");
  } catch (err) {
    console.error("❌ Missing serviceAccountKey.json or invalid format:", err);
    process.exit(1);
  }
}

const db = admin.firestore();

// === EXPRESS SETUP ===
const app = express();
app.use(bodyParser.json());
app.use(cors());

// Simple health check
app.get("/", (req, res) => res.send("Dropee assignment server running"));

// === WEBHOOK: Create booking + auto-assign ===
app.post("/booking", async (req, res) => {
  try {
    const booking = req.body;
    
    // Handle new data format with latitude and longitude
    if (booking.latitude && booking.longitude) {
      booking.pickup = {
        lat: parseFloat(booking.latitude),
        lng: parseFloat(booking.longitude)
      };
      // Remove the original fields to keep data clean
      delete booking.latitude;
      delete booking.longitude;
    }
    
    // Ensure pickup coordinates are properly formatted
    if (!booking || !booking.number) {
      return res.status(400).json({ error: "invalid booking payload: missing required fields" });
    }
    
    if (!booking.pickup) {
      booking.pickup = {
        lat: 0,
        lng: 0
      };
      console.log("Warning: Created default pickup coordinates for booking");
    }

    const newBooking = {
      ...booking,
      status: booking.status || "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Ensure pickup coordinates are numbers
    if (newBooking.pickup) {
      newBooking.pickup.lat = parseFloat(newBooking.pickup.lat);
      newBooking.pickup.lng = parseFloat(newBooking.pickup.lng);
    }

    const ref = await db.collection("bookings").add(newBooking);
    const bookingId = ref.id;

    // best-effort auto-assign
    assignDriverForBooking(admin, bookingId).catch((err) =>
      console.error("assigner error:", err.message)
    );

    res.json({ bookingId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// === FIRESTORE LISTENER ===
function startBookingListener() {
  console.log("Starting Firestore bookings listener...");
  const bookingsQuery = db.collection("bookings").where("status", "==", "pending");

  bookingsQuery.onSnapshot(
    (snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const bookingId = change.doc.id;
          const bookingData = change.doc.data();
          console.log("New pending booking:", bookingData.number || bookingId);
          
          // Handle new data format with latitude and longitude
          if (bookingData.latitude && bookingData.longitude) {
            // Update the document with proper pickup format
            await db.collection("bookings").doc(bookingId).update({
              pickup: {
                lat: parseFloat(bookingData.latitude),
                lng: parseFloat(bookingData.longitude)
              },
              latitude: admin.firestore.FieldValue.delete(),
              longitude: admin.firestore.FieldValue.delete()
            });
            console.log("Updated booking with proper pickup format");
          } else if (!bookingData.pickup) {
            // Create default pickup if missing
            await db.collection("bookings").doc(bookingId).update({
              pickup: {
                lat: 0,
                lng: 0
              }
            });
            console.log("Warning: Created default pickup coordinates for booking");
          }
          
          // Now assign driver
          assignDriverForBooking(admin, bookingId).catch((err) =>
            console.error("assigner error:", err.message)
          );
        }
      });
    },
    (err) => {
      console.error("Listener error:", err);
    }
  );
}

const ENABLE_LISTENER = true;
if (ENABLE_LISTENER) startBookingListener();

// === MANUAL REBALANCE ENDPOINT ===
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

// === PERIODIC REBALANCER ===
function startPeriodicRebalancer() {
  console.log("Starting periodic rebalancer...");

  const REBALANCE_INTERVAL = 5 * 60 * 1000; // 5 minutes

  // Run immediately
  runRebalancer(admin, true).catch((err) => {
    console.error("Rebalancer error:", err);
  });

  // Then run periodically
  setInterval(() => {
    runRebalancer(admin, true).catch((err) => {
      console.error("Rebalancer error:", err);
    });
  }, REBALANCE_INTERVAL);
}

const ENABLE_REBALANCER = true;
if (ENABLE_REBALANCER) startPeriodicRebalancer();

// === START SERVER ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server listening on ${PORT}`));
