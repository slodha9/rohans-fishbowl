import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue, runTransaction } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyABaDYgtfVrrZVw5Agdy7yqXqxAq0GNqks",
  authDomain: "rohans-fishbowl.firebaseapp.com",
  databaseURL: "https://rohans-fishbowl-default-rtdb.firebaseio.com/",
  projectId: "rohans-fishbowl",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const gameRef = ref(db, "fishbowl-game");

// ─── Full overwrite (ONLY for create/reset) ───
export async function saveGame(state) {
  try {
    await set(gameRef, state);
  } catch (e) {
    console.error("Save failed:", e);
  }
}

// ─── Safe multiplayer updates (IMPORTANT) ───
export async function updateGameSafely(updater) {
  try {
    await runTransaction(gameRef, (current) => {
      const base = current || {};
      const updated = updater(base);

      // safety: always increment version
      return {
        ...updated,
        ver: (base.ver || 0) + 1,
      };
    });
  } catch (e) {
    console.error("Transaction failed:", e);
  }
}

// ─── Real-time listener ───
export function onGameUpdate(callback) {
  return onValue(gameRef, (snapshot) => {
    const data = snapshot.val();
    if (data) callback(data);
  });
}
