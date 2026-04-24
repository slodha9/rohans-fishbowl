// ╔══════════════════════════════════════════════════════════════╗
// ║  🔥 PASTE YOUR FIREBASE CONFIG BELOW (Step 2 in guide)    ║
// ║  Replace the 4 placeholder values with your own.           ║
// ╚══════════════════════════════════════════════════════════════╝

import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyABaDYgtfVrrZVw5Agdy7yqXqxAq0GNqks",
  authDomain: "rohans-fishbowl.firebaseapp.com",
  databaseURL: "https://rohans-fishbowl-default-rtdb.firebaseio.com/",
  projectId: "rohans-fishbowl",
};

// ─── Initialize ───
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const gameRef = ref(db, "fishbowl-game");

// ─── Save game state ───
export async function saveGame(state) {
  try {
    await set(gameRef, state);
  } catch (e) {
    console.error("Save failed:", e);
  }
}

// ─── Listen for real-time updates ───
export function onGameUpdate(callback) {
  return onValue(gameRef, (snapshot) => {
    const data = snapshot.val();
    if (data) callback(data);
  });
}
