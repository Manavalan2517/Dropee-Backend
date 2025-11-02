// rebalancer.js
const admin = require("firebase-admin");
const { haversineDistanceKm } = require("./assigner");

/**
 * AI Rebalancer - Periodically analyzes demand patterns and suggests vehicle repositioning
 * to reduce wait times and increase fill rate.
 */

/**
 * Get all idle vehicles that can be rebalanced
 * @returns {Promise<Array>} Array of idle vehicles
 */
async function getIdleVehicles(db) {
  const vehiclesRef = db.collection("vehicles");
  const snapshot = await vehiclesRef.where("status", "==", "idle").get();
  
  const vehicles = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    // Only consider vehicles with no passengers
    if (!data.currentPassengers || data.currentPassengers.length === 0) {
      vehicles.push({
        id: doc.id,
        ...data,
      });
    }
  });
  
  return vehicles;
}

/**
 * Get recent bookings to analyze demand patterns
 * @param {Object} db Firestore database instance
 * @param {number} hours Number of hours to look back
 * @returns {Promise<Array>} Array of recent bookings
 */
async function getRecentBookings(db, hours = 1) {
  const bookingsRef = db.collection("bookings");
  const hoursAgo = new Date();
  hoursAgo.setHours(hoursAgo.getHours() - hours);
  
  const snapshot = await bookingsRef
    .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(hoursAgo))
    .orderBy("createdAt", "desc")
    .get();
  
  const bookings = [];
  snapshot.forEach((doc) => {
    bookings.push({
      id: doc.id,
      ...doc.data(),
    });
  });
  
  return bookings;
}

/**
 * Identify hotspot areas based on recent booking pickup locations
 * @param {Array} recentBookings Array of recent bookings
 * @returns {Array} Array of hotspot locations with their frequency
 */
function identifyHotspots(recentBookings) {
  const hotspots = {};
  
  // Group nearby pickup locations (within 0.5km)
  recentBookings.forEach((booking) => {
    if (!booking.pickup || !booking.pickup.lat || !booking.pickup.lng) return;
    
    // Check if this location is close to an existing hotspot
    let foundMatch = false;
    for (const key in hotspots) {
      const hotspot = hotspots[key];
      const distance = haversineDistanceKm(
        hotspot.location.lat,
        hotspot.location.lng,
        booking.pickup.lat,
        booking.pickup.lng
      );
      
      if (distance < 0.5) { // Within 500m
        hotspots[key].count += 1;
        foundMatch = true;
        break;
      }
    }
    
    // If no match found, create a new hotspot
    if (!foundMatch) {
      const key = `${booking.pickup.lat.toFixed(4)},${booking.pickup.lng.toFixed(4)}`;
      hotspots[key] = {
        location: booking.pickup,
        count: 1,
      };
    }
  });
  
  // Convert to array and sort by count (highest first)
  return Object.values(hotspots).sort((a, b) => b.count - a.count);
}

/**
 * Generate rebalance suggestions for idle vehicles
 * @param {Object} db Firestore database instance
 * @returns {Promise<Array>} Array of rebalance suggestions
 */
async function generateRebalanceSuggestions(db) {
  // Get idle vehicles and recent bookings
  const idleVehicles = await getIdleVehicles(db);
  const recentBookings = await getRecentBookings(db, 1); // Last hour
  
  // No idle vehicles or recent bookings, no suggestions needed
  if (idleVehicles.length === 0 || recentBookings.length === 0) {
    console.log("No idle vehicles or recent bookings found");
    return [];
  }
  
  // Identify hotspot areas
  const hotspots = identifyHotspots(recentBookings);
  
  // Generate suggestions
  const suggestions = [];
  
  idleVehicles.forEach((vehicle) => {
    if (!vehicle.location || !vehicle.location.lat || !vehicle.location.lng) return;
    
    // Find the closest hotspot that doesn't already have a vehicle nearby
    for (const hotspot of hotspots) {
      // Skip if another idle vehicle is already close to this hotspot
      const anotherVehicleNearby = idleVehicles.some((v) => {
        if (v.id === vehicle.id || !v.location) return false;
        
        const distanceToHotspot = haversineDistanceKm(
          v.location.lat,
          v.location.lng,
          hotspot.location.lat,
          hotspot.location.lng
        );
        
        return distanceToHotspot < 1.0; // Within 1km
      });
      
      if (anotherVehicleNearby) continue;
      
      // Calculate distance from vehicle to hotspot
      const distance = haversineDistanceKm(
        vehicle.location.lat,
        vehicle.location.lng,
        hotspot.location.lat,
        hotspot.location.lng
      );
      
      // Only suggest if the vehicle is not already at the hotspot
      if (distance > 0.5) {
        // Calculate priority based on hotspot demand and distance
        // Higher demand and shorter distance = higher priority
        const priority = Math.min(10, Math.round((hotspot.count * 5) / Math.max(1, distance)));
        
        suggestions.push({
          vehicleId: vehicle.id,
          currentLocation: vehicle.location,
          targetLocation: hotspot.location,
          priority,
          distance,
          reason: `High demand area with ${hotspot.count} recent bookings`,
        });
        
        // Only one suggestion per vehicle
        break;
      }
    }
  });
  
  // Sort by priority (highest first)
  return suggestions.sort((a, b) => b.priority - a.priority);
}

/**
 * Apply a rebalance suggestion by updating the vehicle's target location
 * @param {Object} db Firestore database instance
 * @param {Object} suggestion The rebalance suggestion to apply
 * @returns {Promise<void>}
 */
async function applyRebalanceSuggestion(db, suggestion) {
  const vehicleRef = db.collection("vehicles").doc(suggestion.vehicleId);
  
  await vehicleRef.update({
    targetLocation: suggestion.targetLocation,
    rebalanceReason: suggestion.reason,
    rebalanceTimestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
  
  console.log(`Applied rebalance suggestion for vehicle ${suggestion.vehicleId}`);
}

/**
 * Run the rebalancer to generate and optionally apply suggestions
 * @param {Object} admin Firebase admin instance
 * @param {boolean} autoApply Whether to automatically apply the suggestions
 * @returns {Promise<Array>} The generated suggestions
 */
async function runRebalancer(admin, autoApply = false) {
  const db = admin.firestore();
  const suggestions = await generateRebalanceSuggestions(db);
  
  console.log(`Generated ${suggestions.length} rebalance suggestions`);
  
  if (autoApply && suggestions.length > 0) {
    // Apply top suggestions (limit to 3 at a time to avoid too many movements)
    const topSuggestions = suggestions.slice(0, 3);
    for (const suggestion of topSuggestions) {
      await applyRebalanceSuggestion(db, suggestion);
    }
    console.log(`Auto-applied ${topSuggestions.length} rebalance suggestions`);
  }
  
  return suggestions;
}

// Export the functions
module.exports = { runRebalancer };