const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function addDummyVehicles() {
  try {
    const vehiclesRef = db.collection("vehicles");

    const dummyVehicles = [
      {
        driverId: "driver1",
        status: "idle",
        location: { lat: 34.052235, lng: -118.243683 }, // Los Angeles
        currentPassengers: [],
        fcmToken: "some_fcm_token_for_driver1",
      },
      {
        driverId: "driver2",
        status: "idle",
        location: { lat: 34.052235, lng: -118.243683 }, // Los Angeles
        currentPassengers: [],
        fcmToken: "some_fcm_token_for_driver2",
      },
    ];

    for (const vehicle of dummyVehicles) {
      await vehiclesRef.add(vehicle);
      console.log(`Added vehicle for driver: ${vehicle.driverId}`);
    }

    console.log("Dummy vehicles added successfully!");
  } catch (error) {
    console.error("Error adding dummy vehicles:", error);
  }
}

addDummyVehicles().then(() => process.exit());