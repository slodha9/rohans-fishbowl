import { useState, useEffect, useCallback, useRef, useReducer } from "react";

const NUM_ROUNDS = 4;

const FISH_EMOJI = "🐟";
const TROPHY_EMOJI = "🏆";

// ─── Storage ───
const GAME_KEY = "fishbowl-v4";

async function loadGame() {
  try {
    const r = await window.storage.get(GAME_KEY, true);
    return r ? JSON.parse(r.value) : null;
  } catch { return null; }
}

async function saveGame(state) {
  try {
    await window.storage.set(GAME_KEY, JSON.stringify(state), true);
  } catch (e) { console.error("Save failed", e); }
}

// ─── Fresh State ───
function freshGame() {
  return {
    phase: "lobby",
    settings: { timePerTurn: 30 },
    team1: { name: "Team Shark 🦈", players: [], score: 0 },
    team2: { name: "Team Whale 🐋", players: [], score: 0 },
    allPlayers: [],
    words: [],
    roundWords: [],
    currentWordIdx: 0,
    currentRound: 0,
    turnOrder: [],
    currentTurnIdx: 0,
    turnActive: false,
    timeLeft: 30,
    skipsUsed: 0,
    wordsSubmitted: {},
    adminName: null,
    ver: 0,
  };
}

// ─── Styles ───
const C = {
  bg: "#0a0a0f", surface: "#13131f", card: "#1a1a2e",
  accent: "#f72585", accent2: "#7209b7", accent3: "#4cc9f0",
  gold: "#ffd700", text: "#e8e8f0", muted: "#6b6b8d",
  success: "#00e676", danger: "#ff1744", warn: "#ffab00",
  border: "#2a2a44",
};
const F = {
  display: "'Righteous', cursive",
  body: "'Quicksand', sans-serif",
  mono: "'JetBrains Mono', monospace",
};
const FONT_LINK = "https://fonts.googleapis.com/css2?family=Righteous&family=Quicksand:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";

// ─── Small Components ───
function Btn({ children, onClick, color = C.accent, disabled, style }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: disabled ? C.border : `linear-gradient(135deg, ${color}, ${color}cc)`,
      color: "#fff", border: "none", borderRadius: 12,
      padding: "14px 28px", fontSize: 16, fontFamily: F.body, fontWeight: 700,
      cursor: disabled ? "not-allowed" : "pointer",
      boxShadow: disabled ? "none" : `0 0 20px ${color}44`,
      opacity: disabled ? 0.5 : 1, transition: "all .2s", letterSpacing: 0.3,
      ...style,
    }}>{children}</button>
  );
}

function Card({ children, style, glow }) {
  return (
    <div style={{
      background: C.card, borderRadius: 16, border: `1px solid ${C.border}`,
      padding: 24, boxShadow: glow ? `0 0 40px ${C.accent}22` : "0 4px 20px #00000044",
      ...style,
    }}>{children}</div>
  );
}

function Scoreboard({ team1, team2 }) {
  const w1 = team1.score > team2.score, w2 = team2.score > team1.score;
  return (
    <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
      {[team1, team2].map((t, i) => {
        const win = i === 0 ? w1 : w2;
        return (
          <div key={i} style={{
            background: `linear-gradient(135deg, ${i === 0 ? C.accent + "22" : C.accent2 + "22"}, ${C.card})`,
            borderRadius: 14, padding: "14px 24px",
            border: `2px solid ${win ? C.gold : C.border}`,
            boxShadow: win ? `0 0 20px ${C.gold}44` : "none",
            textAlign: "center", minWidth: 150, transition: "all .3s",
          }}>
            <div style={{ fontFamily: F.display, fontSize: 15, color: C.text, marginBottom: 2 }}>
              {t.name} {win ? TROPHY_EMOJI : ""}
            </div>
            <div style={{ fontFamily: F.mono, fontSize: 34, fontWeight: 700, color: win ? C.gold : C.text }}>
              {t.score}
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>{t.players.length} players</div>
          </div>
        );
      })}
    </div>
  );
}

function RoundBadge({ round }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      background: `linear-gradient(90deg, ${C.accent}, ${C.accent2})`,
      borderRadius: 20, padding: "6px 18px", fontFamily: F.display, fontSize: 14, color: "#fff",
    }}>
      Round {round + 1} of {NUM_ROUNDS}
    </div>
  );
}

// ─── Main ───
export default function RohansFishbowl() {
  // Use ref as source of truth to avoid stale closures in timers
  const gameRef = useRef(freshGame());
  const [, forceRender] = useReducer(x => x + 1, 0);
  const game = gameRef.current;

  const setGame = useCallback((g) => {
    gameRef.current = g;
    forceRender();
  }, []);

  // Atomically update + save + render
  const patch = useCallback(async (updates) => {
    const ng = { ...gameRef.current, ...updates, ver: gameRef.current.ver + 1 };
    gameRef.current = ng;
    forceRender();
    await saveGame(ng);
  }, []);

  const [myName, setMyName] = useState("");
  const [joined, setJoined] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [myWords, setMyWords] = useState(["", "", ""]);
  const [inputName, setInputName] = useState("");
  const [team1Name, setTeam1Name] = useState("Team Shark 🦈");
  const [team2Name, setTeam2Name] = useState("Team Whale 🐋");
  const [timeOption, setTimeOption] = useState(30);
  const myNameRef = useRef("");

  // Keep myName ref in sync
  useEffect(() => { myNameRef.current = myName; }, [myName]);

  // ── Polling (accept remote updates only if version is higher) ──
  useEffect(() => {
    const id = setInterval(async () => {
      const remote = await loadGame();
      if (!remote) return;
      const local = gameRef.current;
      if (remote.ver > local.ver) {
        gameRef.current = remote;
        forceRender();
      }
    }, 1200);
    return () => clearInterval(id);
  }, []);

  // ── Timer: runs via setInterval, reads from ref, only admin ticks ──
  useEffect(() => {
    const id = setInterval(async () => {
      const g = gameRef.current;
      const amIAdmin = g.adminName && g.adminName === myNameRef.current;
      if (!amIAdmin || !g.turnActive || g.timeLeft <= 0) return;

      const newTime = g.timeLeft - 1;
      if (newTime <= 0) {
        // Time's up — end turn, advance player
        const ng = {
          ...g,
          timeLeft: g.settings.timePerTurn,
          turnActive: false,
          currentTurnIdx: g.currentTurnIdx + 1,
          skipsUsed: 0,
          ver: g.ver + 1,
        };
        gameRef.current = ng;
        forceRender();
        await saveGame(ng);
      } else {
        const ng = { ...g, timeLeft: newTime, ver: g.ver + 1 };
        gameRef.current = ng;
        forceRender();
        await saveGame(ng);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Derived ──
  const currentTurn = game.turnOrder[game.currentTurnIdx];
  const currentWord = game.roundWords[game.currentWordIdx];
  const isMyTurn = currentTurn && currentTurn.playerName === myName;
  const amAdmin = myName === game.adminName;

  // ══════════ HANDLERS ══════════

  const handleCreate = async () => {
    if (!inputName.trim()) return;
    const g = freshGame();
    g.adminName = inputName.trim();
    g.allPlayers = [inputName.trim()];
    g.settings.timePerTurn = timeOption;
    g.timeLeft = timeOption;
    g.team1.name = team1Name;
    g.team2.name = team2Name;
    g.ver = 1;
    setMyName(inputName.trim());
    setIsAdmin(true);
    setJoined(true);
    setGame(g);
    await saveGame(g);
  };

  const handleJoin = async () => {
    if (!inputName.trim()) return;
    const g = await loadGame();
    if (!g) return alert("No game found! Ask the admin to create one first.");
    if (g.allPlayers.includes(inputName.trim())) {
      // Rejoin
      setMyName(inputName.trim());
      setJoined(true);
      if (g.adminName === inputName.trim()) setIsAdmin(true);
      setGame(g);
      return;
    }
    g.allPlayers.push(inputName.trim());
    g.ver++;
    setMyName(inputName.trim());
    setJoined(true);
    setGame(g);
    await saveGame(g);
  };

  const handleRandomize = async () => {
    const g = gameRef.current;
    const shuffled = [...g.allPlayers].sort(() => Math.random() - 0.5);
    const mid = Math.ceil(shuffled.length / 2);
    let t1 = shuffled.slice(0, mid);
    let t2 = shuffled.slice(mid);
    if (t2.length === 0 && t1.length > 0) t2 = [t1[0]];
    await patch({
      team1: { ...g.team1, name: team1Name, players: t1, score: 0 },
      team2: { ...g.team2, name: team2Name, players: t2, score: 0 },
      phase: "teams",
    });
  };

  const movePlayer = async (player, toTeam) => {
    const g = gameRef.current;
    const t1 = g.team1.players.filter(p => p !== player);
    const t2 = g.team2.players.filter(p => p !== player);
    if (toTeam === 1) t1.push(player); else t2.push(player);
    await patch({
      team1: { ...g.team1, players: t1 },
      team2: { ...g.team2, players: t2 },
    });
  };

  const confirmTeams = () => patch({ phase: "words" });

  const submitWords = async () => {
    if (myWords.some(w => !w.trim())) return alert("Enter all 3 words!");
    const g = gameRef.current;
    const ws = { ...g.wordsSubmitted, [myName]: myWords.map(w => w.trim()) };
    await patch({ wordsSubmitted: ws, words: Object.values(ws).flat() });
  };

  const buildTurnOrder = (t1p, t2p) => {
    const order = [];
    const count = Math.max(t1p.length, t2p.length) * 5;
    let i1 = 0, i2 = 0;
    for (let i = 0; i < count; i++) {
      order.push({ team: 1, playerName: t1p[i1 % t1p.length] });
      i1++;
      order.push({ team: 2, playerName: t2p[i2 % t2p.length] });
      i2++;
    }
    return order;
  };

  const startGame = async () => {
    const g = gameRef.current;
    if (g.words.length === 0) return alert("No words submitted!");
    if (g.team1.players.length === 0 || g.team2.players.length === 0)
      return alert("Both teams need players!");
    const shuffled = [...g.words].sort(() => Math.random() - 0.5);
    const order = buildTurnOrder(g.team1.players, g.team2.players);
    await patch({
      phase: "playing", currentRound: 0, roundWords: shuffled,
      currentWordIdx: 0, turnOrder: order, currentTurnIdx: 0,
      turnActive: false, timeLeft: g.settings.timePerTurn, skipsUsed: 0,
    });
  };

  const startTurn = () => patch({
    turnActive: true,
    timeLeft: gameRef.current.settings.timePerTurn,
    skipsUsed: 0,
  });

  // Helper: check if round is over after removing a word
  const checkRoundEnd = (remainingWords, currentRound) => {
    if (remainingWords.length === 0) {
      return { phase: currentRound >= (NUM_ROUNDS - 1) ? "gameOver" : "roundEnd", turnActive: false };
    }
    return {};
  };

  const handleCorrect = async () => {
    const g = gameRef.current;
    const ct = g.turnOrder[g.currentTurnIdx];
    if (!ct) return;
    const tk = ct.team === 1 ? "team1" : "team2";
    // Remove current word from list (it's done)
    const rw = [...g.roundWords];
    rw.splice(g.currentWordIdx, 1);
    // Adjust index if we're past the end
    const newIdx = g.currentWordIdx >= rw.length ? 0 : g.currentWordIdx;
    const endCheck = checkRoundEnd(rw, g.currentRound);
    await patch({
      [tk]: { ...g[tk], score: g[tk].score + 2 },
      roundWords: rw,
      currentWordIdx: newIdx,
      ...endCheck,
    });
  };

  const handleSkip = async () => {
    const g = gameRef.current;
    const ct = g.turnOrder[g.currentTurnIdx];
    if (!ct) return;
    const tk = ct.team === 1 ? "team1" : "team2";
    // Remove current word (skip = done, word won't come back)
    const rw = [...g.roundWords];
    rw.splice(g.currentWordIdx, 1);
    const newIdx = g.currentWordIdx >= rw.length ? 0 : g.currentWordIdx;
    const endCheck = checkRoundEnd(rw, g.currentRound);
    if (g.skipsUsed < 2) {
      // Free skip — no penalty
      await patch({ roundWords: rw, currentWordIdx: newIdx, skipsUsed: g.skipsUsed + 1, ...endCheck });
    } else {
      // Penalty skip — -1 point
      await patch({
        [tk]: { ...g[tk], score: g[tk].score - 1 },
        roundWords: rw, currentWordIdx: newIdx, skipsUsed: g.skipsUsed + 1,
        ...endCheck,
      });
    }
  };

  const handleIncorrect = async () => {
    const g = gameRef.current;
    // Remove current word (incorrect = done, word won't come back)
    const rw = [...g.roundWords];
    rw.splice(g.currentWordIdx, 1);
    const newIdx = g.currentWordIdx >= rw.length ? 0 : g.currentWordIdx;
    const endCheck = checkRoundEnd(rw, g.currentRound);
    await patch({ roundWords: rw, currentWordIdx: newIdx, ...endCheck });
  };

  const nextRound = async () => {
    const g = gameRef.current;
    const shuffled = [...g.words].sort(() => Math.random() - 0.5);
    await patch({
      phase: "playing", currentRound: g.currentRound + 1,
      roundWords: shuffled, currentWordIdx: 0,
      turnActive: false, timeLeft: g.settings.timePerTurn, skipsUsed: 0,
    });
  };

  const resetGame = async () => {
    const g = freshGame();
    setGame(g);
    setJoined(false); setIsAdmin(false); setMyName(""); setMyWords(["", "", ""]);
    await saveGame(g);
  };

  // ═══════════ RENDER ═══════════
  const inputStyle = {
    width: "100%", padding: "13px 16px", borderRadius: 11,
    background: C.surface, border: `1px solid ${C.border}`,
    color: C.text, fontSize: 15, outline: "none", fontFamily: F.body,
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: `radial-gradient(ellipse at 30% 20%, ${C.accent2}15, transparent 50%),
                    radial-gradient(ellipse at 70% 80%, ${C.accent}10, transparent 50%), ${C.bg}`,
      color: C.text, fontFamily: F.body, padding: "20px 16px",
    }}>
      <link href={FONT_LINK} rel="stylesheet" />
      <style>{`
        @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.06)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        @keyframes fishDrift {
          0%,100%{transform:translateX(0) translateY(0) rotate(0deg)}
          33%{transform:translateX(15px) translateY(-12px) rotate(4deg)}
          66%{transform:translateX(-10px) translateY(-20px) rotate(-3deg)}
        }
        input,select{font-family:${F.body}} *{box-sizing:border-box}
      `}</style>

      {/* Floating fish bg */}
      <div style={{ position: "fixed", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 0 }}>
        {[...Array(10)].map((_, i) => (
          <div key={i} style={{
            position: "absolute", fontSize: 14 + (i % 5) * 4,
            left: `${10 + (i * 9) % 80}%`, top: `${5 + (i * 13) % 85}%`,
            opacity: 0.05, animation: `fishDrift ${10 + i * 2}s ease-in-out infinite`,
            animationDelay: `${i * 0.7}s`,
          }}>{FISH_EMOJI}</div>
        ))}
      </div>

      <div style={{ maxWidth: 580, margin: "0 auto", position: "relative", zIndex: 1 }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h1 style={{
            fontFamily: F.display, fontSize: 30, margin: 0, letterSpacing: 1,
            background: `linear-gradient(90deg, ${C.accent}, ${C.accent3})`,
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>
            {FISH_EMOJI} Rohan's Fishbowl {FISH_EMOJI}
          </h1>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>
            Happy 30th Birthday, Rohan! Let the games begin.
          </div>
        </div>

        {/* ═══ JOIN / CREATE ═══ */}
        {!joined && (
          <Card glow style={{ animation: "fadeIn .5s ease" }}>
            <div style={{ textAlign: "center", marginBottom: 18 }}>
              <div style={{ fontSize: 44, marginBottom: 6 }}>🎂</div>
              <h2 style={{ fontFamily: F.display, fontSize: 21, margin: 0, color: C.accent3 }}>
                Welcome to the Fishbowl
              </h2>
              <p style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>Create a new game or join an existing one</p>
            </div>
            <input value={inputName} onChange={e => setInputName(e.target.value)}
              placeholder="Your name..." style={{ ...inputStyle, marginBottom: 14 }}
              onKeyDown={e => e.key === "Enter" && handleJoin()} />
            <div style={{ marginBottom: 18 }}>
              <label style={{ fontSize: 12, color: C.muted, display: "block", marginBottom: 6 }}>Time per turn</label>
              <div style={{ display: "flex", gap: 6 }}>
                {[15, 30, 45, 60, 90].map(t => (
                  <button key={t} onClick={() => setTimeOption(t)} style={{
                    flex: 1, padding: "9px 0", borderRadius: 9, border: "none",
                    background: timeOption === t ? C.accent : C.surface,
                    color: timeOption === t ? "#fff" : C.muted,
                    fontFamily: F.mono, fontSize: 13, cursor: "pointer",
                    fontWeight: timeOption === t ? 700 : 400, transition: "all .2s",
                  }}>{t}s</button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn onClick={handleCreate} color={C.accent} style={{ flex: 1 }}>Create Game</Btn>
              <Btn onClick={handleJoin} color={C.accent2} style={{ flex: 1 }}>Join Game</Btn>
            </div>
          </Card>
        )}

        {/* ═══ LOBBY ═══ */}
        {joined && game.phase === "lobby" && (
          <Card style={{ animation: "fadeIn .4s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ fontFamily: F.display, margin: 0, color: C.accent3 }}>
                Lobby — {game.settings.timePerTurn}s turns
              </h3>
              <span style={{ fontFamily: F.mono, fontSize: 12, color: C.muted }}>
                {game.allPlayers.length} joined
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 18 }}>
              {game.allPlayers.map(p => (
                <span key={p} style={{
                  background: p === game.adminName ? C.accent + "33" : C.surface,
                  border: `1px solid ${p === game.adminName ? C.accent : C.border}`,
                  borderRadius: 18, padding: "5px 14px", fontSize: 13,
                  color: p === myName ? C.accent3 : C.text,
                  fontWeight: p === myName ? 700 : 400,
                }}>{p}{p === game.adminName ? " 👑" : ""}{p === myName ? " (you)" : ""}</span>
              ))}
            </div>
            {isAdmin && (
              <>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <input value={team1Name} onChange={e => setTeam1Name(e.target.value)}
                    placeholder="Team 1 name" style={{ ...inputStyle, flex: 1 }} />
                  <input value={team2Name} onChange={e => setTeam2Name(e.target.value)}
                    placeholder="Team 2 name" style={{ ...inputStyle, flex: 1 }} />
                </div>
                <Btn onClick={handleRandomize} color={C.accent2} style={{ width: "100%" }}>
                  Randomize Teams & Continue
                </Btn>
              </>
            )}
            {!isAdmin && (
              <p style={{ textAlign: "center", color: C.muted, fontSize: 13 }}>
                Waiting for {game.adminName} to set up teams...
              </p>
            )}
          </Card>
        )}

        {/* ═══ TEAMS ═══ */}
        {joined && game.phase === "teams" && (
          <div style={{ animation: "fadeIn .4s ease" }}>
            <Scoreboard team1={game.team1} team2={game.team2} />
            <Card style={{ marginTop: 14 }}>
              <h3 style={{ fontFamily: F.display, textAlign: "center", color: C.accent3, margin: "0 0 14px" }}>
                Team Setup
              </h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {[game.team1, game.team2].map((team, ti) => (
                  <div key={ti}>
                    <div style={{
                      fontFamily: F.display, fontSize: 14, textAlign: "center", marginBottom: 6,
                      color: ti === 0 ? C.accent : C.accent2,
                    }}>{team.name}</div>
                    {team.players.map(p => (
                      <div key={p} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "5px 10px", borderRadius: 7, background: C.surface,
                        marginBottom: 3, fontSize: 13,
                      }}>
                        <span style={{ color: p === myName ? C.accent3 : C.text }}>
                          {p}{p === myName ? " ★" : ""}
                        </span>
                        {isAdmin && (
                          <button onClick={() => movePlayer(p, ti === 0 ? 2 : 1)} style={{
                            background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11,
                          }}>move →</button>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              {isAdmin && (
                <Btn onClick={confirmTeams} style={{ width: "100%", marginTop: 14 }}>
                  Confirm Teams → Submit Words
                </Btn>
              )}
            </Card>
          </div>
        )}

        {/* ═══ WORDS ═══ */}
        {joined && game.phase === "words" && (
          <Card style={{ animation: "fadeIn .4s ease" }}>
            <h3 style={{ fontFamily: F.display, textAlign: "center", color: C.accent3, margin: "0 0 2px" }}>
              🎉 Words for Rohan
            </h3>
            <p style={{ textAlign: "center", color: C.muted, fontSize: 13, marginBottom: 18 }}>
              Enter 3 words or phrases about the birthday boy!
            </p>
            {game.wordsSubmitted[myName] ? (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 38, marginBottom: 6 }}>✅</div>
                <p style={{ color: C.success, fontWeight: 600, margin: "0 0 4px" }}>Words submitted!</p>
                <p style={{ color: C.muted, fontSize: 13 }}>
                  {Object.keys(game.wordsSubmitted).length} / {game.allPlayers.length} players done
                </p>
              </div>
            ) : (
              <>
                {myWords.map((w, i) => (
                  <input key={i} value={w}
                    onChange={e => { const nw = [...myWords]; nw[i] = e.target.value; setMyWords(nw); }}
                    placeholder={`Word ${i + 1}...`}
                    style={{ ...inputStyle, marginBottom: 9 }} />
                ))}
                <Btn onClick={submitWords} style={{ width: "100%" }}>Submit Words</Btn>
              </>
            )}
            {isAdmin && Object.keys(game.wordsSubmitted).length >= 1 && (
              <Btn onClick={startGame} color={C.success} style={{ width: "100%", marginTop: 12 }}>
                Start Game! ({game.words.length} words from {Object.keys(game.wordsSubmitted).length} players)
              </Btn>
            )}
          </Card>
        )}

        {/* ═══ PLAYING ═══ */}
        {joined && game.phase === "playing" && (
          <div style={{ animation: "fadeIn .4s ease" }}>
            <div style={{ textAlign: "center", marginBottom: 10 }}>
              <RoundBadge round={game.currentRound} />
              <p style={{ color: C.muted, fontSize: 13, marginTop: 5 }}>
                Get through all the cards to finish the round!
              </p>
            </div>

            <Scoreboard team1={game.team1} team2={game.team2} />

            <Card style={{ marginTop: 14, textAlign: "center" }}>
              {currentTurn && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 3 }}>Now playing</div>
                  <div style={{
                    fontFamily: F.display, fontSize: 21,
                    color: currentTurn.team === 1 ? C.accent : C.accent2,
                  }}>{currentTurn.playerName}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>
                    {currentTurn.team === 1 ? game.team1.name : game.team2.name}
                  </div>
                </div>
              )}

              {/* Timer */}
              <div style={{
                fontFamily: F.mono, fontSize: 52, fontWeight: 700,
                color: game.timeLeft <= 5 ? C.danger : game.timeLeft <= 10 ? C.warn : C.accent3,
                animation: game.turnActive && game.timeLeft <= 5 ? "pulse .5s infinite" : "none",
                marginBottom: 10, transition: "color .3s",
              }}>
                {game.timeLeft}s
              </div>

              <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
                {game.roundWords.length} card{game.roundWords.length !== 1 ? "s" : ""} left · Skips used: {game.skipsUsed} (2 free)
              </div>

              {/* Word card */}
              {game.turnActive && (isMyTurn || amAdmin) && currentWord && (
                <div style={{
                  background: `linear-gradient(135deg, ${C.accent}22, ${C.accent2}22)`,
                  borderRadius: 14, padding: "24px 18px", marginBottom: 14,
                  border: `2px solid ${C.accent}55`, animation: "fadeIn .3s ease",
                }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 5 }}>THE WORD IS</div>
                  <div style={{
                    fontFamily: F.display, fontSize: 28, color: C.gold,
                    textShadow: `0 0 18px ${C.gold}44`,
                  }}>{currentWord}</div>
                </div>
              )}

              {/* Waiting */}
              {game.turnActive && !isMyTurn && !amAdmin && (
                <div style={{
                  background: C.surface, borderRadius: 14, padding: "24px 18px", marginBottom: 14,
                }}>
                  <div style={{ fontSize: 36, marginBottom: 6 }}>👀</div>
                  <div style={{ color: C.muted }}>{currentTurn?.playerName} is playing...</div>
                </div>
              )}

              {/* Start Turn */}
              {!game.turnActive && (isMyTurn || amAdmin) && (
                <Btn onClick={startTurn}>
                  {isMyTurn ? "Start My Turn!" : `Start ${currentTurn?.playerName}'s Turn`}
                </Btn>
              )}

              {/* Action Buttons */}
              {game.turnActive && (isMyTurn || amAdmin) && (
                <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                  <Btn onClick={handleCorrect} color={C.success}>✓ Rohan Approves (+2)</Btn>
                  <Btn onClick={handleSkip} color={C.warn}>
                    ⏭ Skip {game.skipsUsed >= 2 ? "(-1)" : `(${2 - game.skipsUsed} free)`}
                  </Btn>
                  <Btn onClick={handleIncorrect} color={C.danger}>✗ Rohan Disapproves</Btn>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ═══ ROUND END ═══ */}
        {joined && game.phase === "roundEnd" && (
          <Card glow style={{ animation: "fadeIn .4s ease", textAlign: "center" }}>
            <div style={{ fontSize: 44, marginBottom: 6 }}>🎉</div>
            <h2 style={{ fontFamily: F.display, color: C.gold, margin: "0 0 6px" }}>
              Round {game.currentRound + 1} Complete!
            </h2>
            <p style={{ color: C.muted, fontSize: 13, marginBottom: 18 }}>
              All cards cleared! {(NUM_ROUNDS - 1) - game.currentRound} round{(NUM_ROUNDS - 1) - game.currentRound !== 1 ? "s" : ""} left.
            </p>
            <Scoreboard team1={game.team1} team2={game.team2} />
            {isAdmin && game.currentRound < (NUM_ROUNDS - 1) && (
              <Btn onClick={nextRound} style={{ marginTop: 18 }}>
                Start Round {game.currentRound + 2}
              </Btn>
            )}
          </Card>
        )}

        {/* ═══ GAME OVER ═══ */}
        {joined && game.phase === "gameOver" && (() => {
          const tied = game.team1.score === game.team2.score;
          const t1Wins = game.team1.score > game.team2.score;
          const winner = t1Wins ? game.team1.name : game.team2.name;
          const loser = t1Wins ? game.team2.name : game.team1.name;
          return (
            <Card glow style={{ animation: "fadeIn .5s ease", textAlign: "center" }}>
              <div style={{ fontSize: 56, marginBottom: 6 }}>🏆🎂🏆</div>
              <h2 style={{
                fontFamily: F.display, fontSize: 26, margin: "0 0 4px",
                background: `linear-gradient(90deg, ${C.gold}, ${C.accent})`,
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              }}>Game Over!</h2>
              <p style={{ color: C.muted, fontSize: 13, marginBottom: 18 }}>
                Happy 30th Birthday, Rohan! Final scores:
              </p>
              <Scoreboard team1={game.team1} team2={game.team2} />
              {tied ? (
                <div style={{ marginTop: 18, fontFamily: F.display, fontSize: 20, color: C.gold }}>
                  It's a Tie! Rohan loves you both equally.
                </div>
              ) : (
                <div style={{ marginTop: 18 }}>
                  <div style={{ fontFamily: F.display, fontSize: 20, color: C.success, marginBottom: 8 }}>
                    {winner} Wins! 🎉
                  </div>
                  <div style={{ fontFamily: F.display, fontSize: 16, color: C.success }}>
                    Rohan is proud of you!
                  </div>
                  <div style={{ fontFamily: F.display, fontSize: 14, color: C.danger, marginTop: 10, opacity: 0.8 }}>
                    {loser} — Rohan is disappointed in you.
                  </div>
                </div>
              )}
              {isAdmin && (
                <Btn onClick={resetGame} color={C.muted} style={{ marginTop: 18 }}>Reset Game</Btn>
              )}
            </Card>
          );
        })()}

        <div style={{ textAlign: "center", marginTop: 28, color: C.muted, fontSize: 10 }}>
          Made with {FISH_EMOJI} for Rohan's birthday
        </div>
      </div>
    </div>
  );
}
