// assigner.js
const haversineDistanceKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

async function assignDriverForBooking(admin, bookingId) {
  const db = admin.firestore();
  const bookingRef = db.collection("bookings").doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new Error("Booking not found");
  const booking = bookingSnap.data();

  if (booking.status !== "pending") {
    console.log("Booking not pending; skipping", bookingId);
    return;
  }
  if (!booking.pickup || booking.pickup.lat == null || booking.pickup.lng == null) {
    throw new Error("Booking missing pickup coordinates");
  }

  const pickupLat = parseFloat(booking.pickup.lat);
  const pickupLng = parseFloat(booking.pickup.lng);

  if (isNaN(pickupLat) || isNaN(pickupLng)) {
    throw new Error("Booking pickup coordinates are not valid numbers");
  }

  // 1) Fetch candidate vehicles: status == 'idle'
  const vehiclesSnap = await db.collection("vehicles").where("status", "==", "idle").get();
  const candidates = [];
  vehiclesSnap.forEach((doc) => {
    const v = doc.data();
    const passengers = Array.isArray(v.currentPassengers) ? v.currentPassengers : [];
    if (passengers.length >= 7) return; // skip full
    if (!v.location || v.location.lat == null || v.location.lng == null) return; // skip missing location
    const dist = haversineDistanceKm(v.location.lat, v.location.lng, pickupLat, pickupLng);
    candidates.push({
      id: doc.id,
      driverId: v.driverId,
      dist,
      passengerCount: passengers.length,
      fcmToken: v.fcmToken || null,
      raw: v,
    });
  });

  if (candidates.length === 0) {
    console.log("No available vehicles for booking", bookingId);
    // Optionally mark booking as 'waiting' or leave as pending for retry
    return;
  }

  // sort by distance then by fewer passengers
  candidates.sort((a, b) => {
    if (Math.abs(a.dist - b.dist) < 0.001) { // if extremely close, compare passengers
      return a.passengerCount - b.passengerCount;
    }
    return a.dist - b.dist;
  });

  const chosen = candidates[0];
  console.log(`Chosen vehicle ${chosen.id} dist=${chosen.dist.toFixed(3)}km passengers=${chosen.passengerCount}`);

  // transactionally assign
  await db.runTransaction(async (t) => {
    const bSnap = await t.get(bookingRef);
    if (!bSnap.exists) throw new Error("Booking disappeared");
    const bData = bSnap.data();
    if (bData.status !== "pending") throw new Error("Booking already handled");

    const vRef = db.collection("vehicles").doc(chosen.id);
    const vSnap = await t.get(vRef);
    if (!vSnap.exists) throw new Error("Vehicle disappeared");
    const vData = vSnap.data();
    const passengers = Array.isArray(vData.currentPassengers) ? vData.currentPassengers : [];
    if (passengers.length >= 7) throw new Error("Vehicle full at transaction time");

    // generate verification code (last 4 digits of phone)
    const phone = (bData.number || "").toString();
    const verificationCode = phone.slice(-4) || Math.floor(1000 + Math.random() * 9000).toString();

    t.update(bookingRef, {
      assignedVehicleId: chosen.id,
      assignedDriverId: chosen.driverId || null,
      status: "assigned",
      verificationCode,
      assignedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    t.update(vRef, {
      currentPassengers: [...passengers, bookingId],
    });
  });

  console.log("Assigned booking", bookingId, "to vehicle", chosen.id);

  // send FCM to driver (if token present)
  if (chosen.fcmToken) {
    const payload = {
      token: chosen.fcmToken,
      notification: {
        title: "New pickup assigned",
        body: `Pickup at ${booking.pickup.lat.toFixed ? booking.pickup.lat.toFixed(5) : booking.pickup.lat}, verification ${booking.number ? (booking.number + '').slice(-4) : 'xxxx'}`,
      },
      data: {
        bookingId,
        verificationCode: (booking.number || "").slice(-4)
      }
    };

    try {
      // use firebase-admin messaging
      const message = {
        token: chosen.fcmToken,
        notification: {
          title: "New booking assigned",
          body: `Pickup: ${booking.drop || 'pickup'} — verification ${ (booking.number||'').slice(-4) }`
        },
        data: {
          bookingId,
          verificationCode: (booking.number || '').slice(-4),
        }
      };

      await admin.messaging().send(message);
      console.log("FCM sent to driver", chosen.driverId || chosen.id);
    } catch (err) {
      console.error("Failed sending FCM:", err);
    }
  } else {
    console.log("No FCM token for chosen vehicle; skipping push");
  }
}

module.exports = { assignDriverForBooking };
