import { useState, useEffect, useRef, useReducer, useCallback } from "react";
import { saveGame, onGameUpdate } from "./firebase.js";

/*
 * BUG FIXES APPLIED:
 * #1  Only admin ends turns on timer (no double-fire with current player)
 * #2  Replaced busy flag with queued-patch that retries instead of dropping
 * #3  startTurn no longer reshuffles words (shuffle only at round start)
 * #4  Round-end does NOT increment currentTurnIdx; nextRound does +1
 * #5  Turn order uses modulo wrap-around (never exhausts)
 * #6  Randomize blocked when 0 players
 * #7  ensureArray() guards all array reads from Firebase
 * #8  savingRef always clears in finally block (no permanent lock)
 * #9  handleIncorrect guards on currentTurn
 * #10 TurnOrderPreview on teams page built from live team state
 * #11 "Waiting for players" message when 0 players
 * #12 Duplicate word warning on submit
 * #13 resetGame clears roundOption and timeOption
 * #14 Timer uses turnStartedAt timestamp (robust to tab throttle)
 * #16 startGame reuses stored turnOrder
 * #17 adminSessionId prevents stale admin tabs from acting
 * #18 handleJoin waits for Firebase data before checking
 * #19 Start Game warns if not all players submitted
 * #20 movePlayer prevents emptying a team
 * #21 Player names sanitized for Firebase-illegal chars
 * #22 Safe cleanup of onGameUpdate listener
 * #23 TurnOrderPreview uses ensureArray
 * #24 All mutating buttons disabled during save
 * #25 auditEntry captures word before removal
 */

const DEFAULT_NUM_ROUNDS = 4;
const FISH = "🐟";
const TROPHY = "🏆";

function freshGame() {
  return {
    phase: "lobby",
    settings: { timePerTurn: 30, numRounds: DEFAULT_NUM_ROUNDS },
    team1: { name: "Team Shark 🦈", players: [], score: 0 },
    team2: { name: "Team Whale 🐋", players: [], score: 0 },
    allPlayers: [],
    words: [],
    roundWords: [],
    currentRound: 0,
    turnOrder: [],
    currentTurnIdx: 0,
    turnActive: false,
    turnStartedAt: 0,
    skipsUsed: 0,
    wordsSubmitted: {},
    wordLog: [],
    adminName: null,
    adminSessionId: null,
    ver: 0,
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (val && typeof val === "object") return Object.values(val);
  return [];
}

function sanitizeName(name) {
  return name.replace(/[.$#\[\]\/]/g, "").trim();
}

const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
            <div style={{ fontFamily: F.display, fontSize: 15, color: C.text, marginBottom: 2 }}>{t.name} {win ? TROPHY : ""}</div>
            <div style={{ fontFamily: F.mono, fontSize: 34, fontWeight: 700, color: win ? C.gold : C.text }}>{t.score}</div>
            <div style={{ fontSize: 11, color: C.muted }}>{ensureArray(t.players).length} players</div>
          </div>
        );
      })}
    </div>
  );
}

function RoundBadge({ round, totalRounds }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: `linear-gradient(90deg, ${C.accent}, ${C.accent2})`, borderRadius: 20, padding: "6px 18px", fontFamily: F.display, fontSize: 14, color: "#fff" }}>
      Round {round + 1} of {totalRounds}
    </div>
  );
}

function RoundWordAudit({ logs, round, title }) {
  const roundLogs = ensureArray(logs).filter(l => l.round === round);
  const groups = [
    { key: "approved", label: "Rohan Approved", color: C.success },
    { key: "skipped", label: "Skipped", color: C.warn },
    { key: "disapproved", label: "Rohan Disapproved", color: C.danger },
  ];
  return (
    <Card style={{ marginTop: 14, textAlign: "left" }}>
      <h3 style={{ fontFamily: F.display, textAlign: "center", color: C.accent3, margin: "0 0 14px" }}>{title || `Round ${round + 1} Word Log`}</h3>
      {groups.map(group => {
        const items = roundLogs.filter(l => l.result === group.key);
        return (
          <div key={group.key} style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: F.display, color: group.color, fontSize: 14, marginBottom: 6 }}>{group.label}</div>
            {items.length === 0 ? (
              <div style={{ color: C.muted, fontSize: 12, background: C.surface, borderRadius: 8, padding: "8px 10px" }}>None</div>
            ) : items.map((item, idx) => (
              <div key={`${item.word}-${idx}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, background: C.surface, borderRadius: 8, padding: "8px 10px", marginBottom: 5, fontSize: 13 }}>
                <span style={{ color: C.text, fontWeight: 700 }}>{item.word}</span>
                <span style={{ color: C.muted, textAlign: "right" }}>by {item.playerName} · {item.teamName}</span>
              </div>
            ))}
          </div>
        );
      })}
    </Card>
  );
}

function FullGameAudit({ logs, totalRounds }) {
  return (
    <div style={{ marginTop: 14 }}>
      {[...Array(totalRounds)].map((_, r) => {
        const has = ensureArray(logs).some(l => l.round === r);
        return has ? <RoundWordAudit key={r} logs={logs} round={r} title={`Round ${r + 1} Word Log`} /> : null;
      })}
    </div>
  );
}

function TurnOrderPreview({ order, team1, team2 }) {
  const safeOrder = ensureArray(order);
  if (safeOrder.length === 0) return null;
  const cycle = Math.max(1, ensureArray(team1.players).length + ensureArray(team2.players).length);
  const preview = safeOrder.slice(0, Math.min(safeOrder.length, cycle * 2));
  return (
    <Card style={{ marginTop: 14 }}>
      <h3 style={{ fontFamily: F.display, textAlign: "center", color: C.accent3, margin: "0 0 10px" }}>Fixed Playing Order</h3>
      <div style={{ color: C.muted, fontSize: 12, textAlign: "center", marginBottom: 12 }}>This sequence repeats as rounds continue.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {preview.map((turn, idx) => (
          <div key={`${turn.playerName}-${idx}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: C.surface, borderRadius: 9, padding: "8px 10px", fontSize: 13 }}>
            <span style={{ fontFamily: F.mono, color: C.muted }}>#{idx + 1}</span>
            <span style={{ flex: 1, color: C.text, fontWeight: 700 }}>{turn.playerName}</span>
            <span style={{ color: turn.team === 1 ? C.accent : C.accent2 }}>{turn.team === 1 ? team1.name : team2.name}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════
export default function App() {
  const gRef = useRef(freshGame());
  const [, render] = useReducer(x => x + 1, 0);
  const game = gRef.current;

  const [myName, setMyName] = useState("");
  const [joined, setJoined] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [myWords, setMyWords] = useState(["", "", ""]);
  const [inputName, setInputName] = useState("");
  const [team1Name, setTeam1Name] = useState("Team Shark 🦈");
  const [team2Name, setTeam2Name] = useState("Team Whale 🐋");
  const [timeOption, setTimeOption] = useState(30);
  const [roundOption, setRoundOption] = useState(DEFAULT_NUM_ROUNDS);
  const [localTime, setLocalTime] = useState(30);
  const [saving, setSaving] = useState(false);
  const [firebaseReady, setFirebaseReady] = useState(false);
  const myNameRef = useRef("");
  const savingRef = useRef(false);

  useEffect(() => { myNameRef.current = myName; }, [myName]);

  // Fix #2/#8: safe patch — waits for prior save, always clears on error
  const patch = useCallback(async (updates) => {
    let attempts = 0;
    while (savingRef.current && attempts < 30) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const ng = { ...gRef.current, ...updates, ver: (gRef.current.ver || 0) + 1 };
      gRef.current = ng;
      render();
      await saveGame(ng);
    } catch (e) {
      console.error("Patch failed:", e);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  // Firebase listener
  useEffect(() => {
    const unsub = onGameUpdate((remote) => {
      if (!remote) return;
      setFirebaseReady(true);
      if ((remote.ver || 0) > (gRef.current.ver || 0)) {
        gRef.current = remote;
        render();
        if (remote.turnActive && remote.turnStartedAt) {
          const elapsed = Math.floor((Date.now() - remote.turnStartedAt) / 1000);
          setLocalTime(Math.max(0, (remote.settings?.timePerTurn || 30) - elapsed));
        } else if (!remote.turnActive) {
          setLocalTime(remote.settings?.timePerTurn || 30);
        }
      }
    });
    return () => { if (typeof unsub === "function") unsub(); };
  }, []);

  // Fix #1/#14/#17: Local timer — only active admin session auto-ends turns
  useEffect(() => {
    const id = setInterval(() => {
      const g = gRef.current;
      if (!g.turnActive || !g.turnStartedAt) return;
      const elapsed = Math.floor((Date.now() - g.turnStartedAt) / 1000);
      const remaining = Math.max(0, (g.settings?.timePerTurn || 30) - elapsed);
      setLocalTime(remaining);

      const isActiveAdmin = g.adminName === myNameRef.current && g.adminSessionId === SESSION_ID;
      if (remaining <= 0 && isActiveAdmin && !savingRef.current) {
        savingRef.current = true;
        setSaving(true);
        const ng = {
          ...g,
          turnActive: false,
          turnStartedAt: 0,
          roundWords: ensureArray(g.roundWords), // no reshuffle (#3)
          currentTurnIdx: (g.currentTurnIdx || 0) + 1,
          skipsUsed: 0,
          ver: (g.ver || 0) + 1,
        };
        gRef.current = ng;
        render();
        setLocalTime(g.settings?.timePerTurn || 30);
        saveGame(ng).finally(() => { savingRef.current = false; setSaving(false); });
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  // Fix #5: modulo wrap for turn order
  const turnOrder = ensureArray(game.turnOrder);
  const safeTurnIdx = turnOrder.length > 0 ? (game.currentTurnIdx || 0) % turnOrder.length : 0;
  const currentTurn = turnOrder[safeTurnIdx] || null;
  const roundWords = ensureArray(game.roundWords);
  const currentWord = roundWords[0] || null;
  const isMyTurn = currentTurn && currentTurn.playerName === myName;
  const amAdmin = myName === game.adminName;
  const players = ensureArray(game.allPlayers);
  const submitted = game.wordsSubmitted || {};
  const submittedCount = Object.keys(submitted).length;
  const totalRounds = game.settings?.numRounds || DEFAULT_NUM_ROUNDS;

  // ══════════ HANDLERS ══════════

  const handleCreate = async () => {
    const name = sanitizeName(inputName);
    if (!name) return alert("Enter a valid name (avoid . $ # [ ] / characters)");
    const g = freshGame();
    g.adminName = name;
    g.settings.timePerTurn = timeOption;
    g.settings.numRounds = roundOption;
    g.team1.name = team1Name;
    g.team2.name = team2Name;
    g.adminSessionId = SESSION_ID;
    g.ver = 1;
    setMyName(name); setIsAdmin(true); setJoined(true); setLocalTime(timeOption);
    gRef.current = g; render();
    await saveGame(g);
  };

  const handleJoin = async () => {
    const name = sanitizeName(inputName);
    if (!name) return alert("Enter a valid name (avoid . $ # [ ] / characters)");
    if (!firebaseReady) await new Promise(r => setTimeout(r, 1500));
    const g = gRef.current;
    if (!g.adminName) return alert("No game found! Ask the admin to create one first.");
    if (g.adminName === name) {
      setMyName(name); setIsAdmin(true); setJoined(true);
      await patch({ adminSessionId: SESSION_ID });
      return;
    }
    if (players.includes(name)) {
      setMyName(name); setJoined(true);
      return;
    }
    setMyName(name); setJoined(true);
    await patch({ allPlayers: [...players, name] });
  };

  const handleRandomize = async () => {
    if (players.length === 0) return alert("No players have joined yet!");
    const shuffled = shuffle(players);
    const mid = Math.ceil(shuffled.length / 2);
    const t1 = shuffled.slice(0, mid);
    const t2 = shuffled.slice(mid);
    if (t2.length === 0) t2.push(t1[0]);
    await patch({
      team1: { name: team1Name, players: t1, score: 0 },
      team2: { name: team2Name, players: t2, score: 0 },
      phase: "teams",
    });
  };

  const movePlayer = async (player, toTeam) => {
    const g = gRef.current;
    const t1 = ensureArray(g.team1.players).filter(p => p !== player);
    const t2 = ensureArray(g.team2.players).filter(p => p !== player);
    if (toTeam === 1) t1.push(player); else t2.push(player);
    if (t1.length === 0 || t2.length === 0) return alert("Can't leave a team empty!");
    await patch({ team1: { ...g.team1, players: t1 }, team2: { ...g.team2, players: t2 } });
  };

  const buildTurnOrder = (t1p, t2p) => {
    const order = [];
    const count = Math.max(t1p.length, t2p.length) * (totalRounds + 4);
    let i1 = 0, i2 = 0;
    for (let i = 0; i < count; i++) {
      order.push({ team: 1, playerName: t1p[i1 % t1p.length] }); i1++;
      order.push({ team: 2, playerName: t2p[i2 % t2p.length] }); i2++;
    }
    return order;
  };

  const confirmTeams = () => {
    const g = gRef.current;
    const t1p = ensureArray(g.team1.players);
    const t2p = ensureArray(g.team2.players);
    if (t1p.length === 0 || t2p.length === 0) return alert("Both teams need players!");
    return patch({ phase: "words", turnOrder: buildTurnOrder(t1p, t2p), currentTurnIdx: 0 });
  };

  const submitWords = async () => {
    if (myWords.some(w => !w.trim())) return alert("Enter all 3 words!");
    const g = gRef.current;
    const trimmed = myWords.map(w => w.trim());
    const existing = ensureArray(g.words);
    const dupes = trimmed.filter(w => existing.map(e => e.toLowerCase()).includes(w.toLowerCase()));
    if (dupes.length > 0 && !confirm(`"${dupes.join('", "')}" already submitted by someone. Submit anyway?`)) return;
    const ws = { ...(g.wordsSubmitted || {}), [myName]: trimmed };
    await patch({ wordsSubmitted: ws, words: Object.values(ws).flat() });
  };

  const startGame = async () => {
    const g = gRef.current;
    const w = ensureArray(g.words);
    if (w.length === 0) return alert("No words submitted!");
    const t1p = ensureArray(g.team1.players);
    const t2p = ensureArray(g.team2.players);
    if (t1p.length === 0 || t2p.length === 0) return alert("Both teams need players!");
    if (submittedCount < players.length && !confirm(`Only ${submittedCount}/${players.length} players submitted. Start anyway?`)) return;
    const stored = ensureArray(g.turnOrder);
    await patch({
      phase: "playing", currentRound: 0,
      roundWords: shuffle(w),
      turnOrder: stored.length > 0 ? stored : buildTurnOrder(t1p, t2p),
      currentTurnIdx: 0,
      turnActive: false, turnStartedAt: 0, skipsUsed: 0, wordLog: [],
    });
    setLocalTime(g.settings.timePerTurn);
  };

  // Fix #3: no reshuffle on turn start
  const startTurn = async () => {
    setLocalTime(gRef.current.settings.timePerTurn);
    await patch({ turnActive: true, turnStartedAt: Date.now(), skipsUsed: 0 });
  };

  // Fix #25: capture word before removal
  const auditEntry = (g, result) => {
    const order = ensureArray(g.turnOrder);
    const idx = order.length > 0 ? (g.currentTurnIdx || 0) % order.length : 0;
    const turn = order[idx] || {};
    return {
      round: g.currentRound || 0,
      word: ensureArray(g.roundWords)[0] || "???",
      result,
      playerName: turn.playerName || "Unknown",
      team: turn.team || null,
      teamName: turn.team === 1 ? (g.team1?.name || "Team 1") : (g.team2?.name || "Team 2"),
    };
  };

  const removeCurrentWord = (g) => {
    const rw = [...ensureArray(g.roundWords)];
    rw.shift();
    const numR = g.settings?.numRounds || DEFAULT_NUM_ROUNDS;
    const roundDone = rw.length === 0;
    const gameDone = roundDone && (g.currentRound || 0) >= numR - 1;
    return { rw, phase: gameDone ? "gameOver" : roundDone ? "roundEnd" : g.phase, roundDone };
  };

  // Fix #4: round-end does NOT increment currentTurnIdx
  const handleCorrect = async () => {
    const g = gRef.current;
    if (!currentTurn || !currentWord) return;
    const tk = currentTurn.team === 1 ? "team1" : "team2";
    const entry = auditEntry(g, "approved");
    const { rw, phase, roundDone } = removeCurrentWord(g);
    await patch({
      [tk]: { ...g[tk], score: (g[tk].score || 0) + 2 },
      wordLog: [...ensureArray(g.wordLog), entry],
      roundWords: rw, phase,
      turnActive: roundDone ? false : g.turnActive,
      turnStartedAt: roundDone ? 0 : g.turnStartedAt,
    });
  };

  const handleSkip = async () => {
    const g = gRef.current;
    if (!currentTurn || !currentWord) return;
    const tk = currentTurn.team === 1 ? "team1" : "team2";
    const skips = g.skipsUsed || 0;
    const entry = auditEntry(g, "skipped");
    const { rw, phase, roundDone } = removeCurrentWord(g);
    await patch({
      [tk]: { ...g[tk], score: (g[tk].score || 0) + (skips < 2 ? 0 : -1) },
      wordLog: [...ensureArray(g.wordLog), entry],
      roundWords: rw, skipsUsed: skips + 1, phase,
      turnActive: roundDone ? false : g.turnActive,
      turnStartedAt: roundDone ? 0 : g.turnStartedAt,
    });
  };

  // Fix #9: guards currentTurn
  const handleIncorrect = async () => {
    const g = gRef.current;
    if (!currentTurn || !currentWord) return;
    const entry = auditEntry(g, "disapproved");
    const { rw, phase, roundDone } = removeCurrentWord(g);
    await patch({
      wordLog: [...ensureArray(g.wordLog), entry],
      roundWords: rw, phase,
      turnActive: roundDone ? false : g.turnActive,
      turnStartedAt: roundDone ? 0 : g.turnStartedAt,
    });
  };

  // Fix #4: nextRound increments currentTurnIdx by 1 (advance past player who ended round)
  const nextRound = async () => {
    const g = gRef.current;
    setLocalTime(g.settings.timePerTurn);
    await patch({
      phase: "playing",
      currentRound: (g.currentRound || 0) + 1,
      roundWords: shuffle(ensureArray(g.words)),
      currentTurnIdx: (g.currentTurnIdx || 0) + 1,
      turnActive: false, turnStartedAt: 0, skipsUsed: 0,
    });
  };

  // Fix #13: clears local option state
  const resetGame = async () => {
    gRef.current = freshGame(); render();
    setJoined(false); setIsAdmin(false); setMyName(""); setMyWords(["", "", ""]);
    setTimeOption(30); setRoundOption(DEFAULT_NUM_ROUNDS); setLocalTime(30);
    await saveGame(freshGame());
  };

  // ═══════════ RENDER ═══════════
  const S = {
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
        @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes fishDrift{0%,100%{transform:translateX(0) translateY(0) rotate(0deg)}33%{transform:translateX(15px) translateY(-12px) rotate(4deg)}66%{transform:translateX(-10px) translateY(-20px) rotate(-3deg)}}
        input,select{font-family:${F.body}} *{box-sizing:border-box}
      `}</style>

      <div style={{position:"fixed",inset:0,overflow:"hidden",pointerEvents:"none",zIndex:0}}>
        {[...Array(10)].map((_,i)=>(
          <div key={i} style={{position:"absolute",fontSize:14+(i%5)*4,left:`${10+(i*9)%80}%`,top:`${5+(i*13)%85}%`,opacity:0.05,animation:`fishDrift ${10+i*2}s ease-in-out infinite`,animationDelay:`${i*0.7}s`}}>{FISH}</div>
        ))}
      </div>

      <div style={{maxWidth:580,margin:"0 auto",position:"relative",zIndex:1}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <h1 style={{fontFamily:F.display,fontSize:30,margin:0,letterSpacing:1,background:`linear-gradient(90deg,${C.accent},${C.accent3})`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
            {FISH} Rohan's Fishbowl {FISH}
          </h1>
          <div style={{color:C.muted,fontSize:12,marginTop:3}}>Happy 30th Birthday, Rohan! Let the games begin.</div>
        </div>

        {/* JOIN / CREATE */}
        {!joined && (
          <Card glow style={{animation:"fadeIn .5s ease"}}>
            <div style={{textAlign:"center",marginBottom:18}}>
              <div style={{fontSize:44,marginBottom:6}}>🎂</div>
              <h2 style={{fontFamily:F.display,fontSize:21,margin:0,color:C.accent3}}>Welcome to the Fishbowl</h2>
              <p style={{color:C.muted,fontSize:13,marginTop:4}}>Create a new game or join an existing one</p>
            </div>
            <input value={inputName} onChange={e=>setInputName(e.target.value)} placeholder="Your name..." style={{...S,marginBottom:14}} onKeyDown={e=>e.key==="Enter"&&handleJoin()} />
            <div style={{marginBottom:18}}>
              <label style={{fontSize:12,color:C.muted,display:"block",marginBottom:6}}>Time per turn</label>
              <div style={{display:"flex",gap:6}}>
                {[15,30,45,60,90].map(t=>(
                  <button key={t} onClick={()=>setTimeOption(t)} style={{flex:1,padding:"9px 0",borderRadius:9,border:"none",background:timeOption===t?C.accent:C.surface,color:timeOption===t?"#fff":C.muted,fontFamily:F.mono,fontSize:13,cursor:"pointer",fontWeight:timeOption===t?700:400,transition:"all .2s"}}>{t}s</button>
                ))}
              </div>
            </div>
            <div style={{marginBottom:18}}>
              <label style={{fontSize:12,color:C.muted,display:"block",marginBottom:6}}>Number of rounds</label>
              <div style={{display:"flex",gap:6}}>
                {[1,2,3,4,5,6].map(r=>(
                  <button key={r} onClick={()=>setRoundOption(r)} style={{flex:1,padding:"9px 0",borderRadius:9,border:"none",background:roundOption===r?C.accent2:C.surface,color:roundOption===r?"#fff":C.muted,fontFamily:F.mono,fontSize:13,cursor:"pointer",fontWeight:roundOption===r?700:400,transition:"all .2s"}}>{r}</button>
                ))}
              </div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <Btn onClick={handleCreate} color={C.accent} style={{flex:1}} disabled={saving}>Create Game</Btn>
              <Btn onClick={handleJoin} color={C.accent2} style={{flex:1}} disabled={saving}>Join Game</Btn>
            </div>
          </Card>
        )}

        {/* LOBBY */}
        {joined && game.phase==="lobby" && (
          <Card style={{animation:"fadeIn .4s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <h3 style={{fontFamily:F.display,margin:0,color:C.accent3}}>Lobby — {game.settings?.timePerTurn||30}s · {totalRounds} rnd{totalRounds!==1?"s":""}</h3>
              <span style={{fontFamily:F.mono,fontSize:12,color:C.muted}}>{players.length} joined</span>
            </div>
            {players.length===0?(
              <div style={{textAlign:"center",color:C.muted,fontSize:13,padding:"16px 0",background:C.surface,borderRadius:10,marginBottom:18}}>Waiting for players to join...</div>
            ):(
              <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:18}}>
                {players.map(p=>(
                  <span key={p} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:18,padding:"5px 14px",fontSize:13,color:p===myName?C.accent3:C.text,fontWeight:p===myName?700:400}}>{p}{p===myName?" (you)":""}</span>
                ))}
              </div>
            )}
            {amAdmin && (
              <div style={{textAlign:"center",marginBottom:14}}>
                <span style={{background:C.accent+"33",border:`1px solid ${C.accent}`,borderRadius:18,padding:"5px 14px",fontSize:13,color:C.accent}}>👑 {myName} (admin)</span>
              </div>
            )}
            {isAdmin && (<>
              <div style={{display:"flex",gap:8,marginBottom:12}}>
                <input value={team1Name} onChange={e=>setTeam1Name(e.target.value)} placeholder="Team 1" style={{...S,flex:1}} />
                <input value={team2Name} onChange={e=>setTeam2Name(e.target.value)} placeholder="Team 2" style={{...S,flex:1}} />
              </div>
              <Btn onClick={handleRandomize} color={C.accent2} style={{width:"100%"}} disabled={saving||players.length===0}>Randomize Teams & Continue</Btn>
            </>)}
            {!isAdmin && <p style={{textAlign:"center",color:C.muted,fontSize:13}}>Waiting for {game.adminName} to set up teams...</p>}
          </Card>
        )}

        {/* TEAMS */}
        {joined && game.phase==="teams" && (
          <div style={{animation:"fadeIn .4s ease"}}>
            <Scoreboard team1={game.team1} team2={game.team2} />
            <Card style={{marginTop:14}}>
              <h3 style={{fontFamily:F.display,textAlign:"center",color:C.accent3,margin:"0 0 14px"}}>Team Setup</h3>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                {[game.team1,game.team2].map((team,ti)=>(
                  <div key={ti}>
                    <div style={{fontFamily:F.display,fontSize:14,textAlign:"center",marginBottom:6,color:ti===0?C.accent:C.accent2}}>{team.name}</div>
                    {ensureArray(team.players).map(p=>(
                      <div key={p} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 10px",borderRadius:7,background:C.surface,marginBottom:3,fontSize:13}}>
                        <span style={{color:p===myName?C.accent3:C.text}}>{p}{p===myName?" ★":""}</span>
                        {isAdmin && <button onClick={()=>movePlayer(p,ti===0?2:1)} disabled={saving} style={{background:"none",border:"none",color:saving?C.border:C.muted,cursor:saving?"not-allowed":"pointer",fontSize:11}}>move →</button>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              {isAdmin && <Btn onClick={confirmTeams} style={{width:"100%",marginTop:14}} disabled={saving}>Confirm Teams → Submit Words</Btn>}
            </Card>
            {isAdmin && <TurnOrderPreview order={buildTurnOrder(ensureArray(game.team1.players),ensureArray(game.team2.players))} team1={game.team1} team2={game.team2} />}
          </div>
        )}

        {/* WORDS */}
        {joined && game.phase==="words" && (
          <Card style={{animation:"fadeIn .4s ease"}}>
            <h3 style={{fontFamily:F.display,textAlign:"center",color:C.accent3,margin:"0 0 2px"}}>🎉 Words for Rohan</h3>
            <p style={{textAlign:"center",color:C.muted,fontSize:13,marginBottom:18}}>Enter 3 words or phrases about the birthday boy!</p>
            {isAdmin ? (
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:38,marginBottom:6}}>👑</div>
                <p style={{color:C.accent3,fontWeight:600,margin:"0 0 4px"}}>Admin / Monitor</p>
                <p style={{color:C.muted,fontSize:13}}>{players.length===0?"No players yet":`${submittedCount} / ${players.length} players done`}</p>
              </div>
            ) : submitted[myName] ? (
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:38,marginBottom:6}}>✅</div>
                <p style={{color:C.success,fontWeight:600,margin:"0 0 4px"}}>Words submitted!</p>
                <p style={{color:C.muted,fontSize:13}}>{submittedCount} / {players.length} players done</p>
              </div>
            ) : (<>
              {myWords.map((w,i)=>(
                <input key={i} value={w} onChange={e=>{const nw=[...myWords];nw[i]=e.target.value;setMyWords(nw)}} placeholder={`Word ${i+1}...`} style={{...S,marginBottom:9}} />
              ))}
              <Btn onClick={submitWords} style={{width:"100%"}} disabled={saving}>Submit Words</Btn>
            </>)}
            {isAdmin && submittedCount>=1 && (
              <Btn onClick={startGame} color={C.success} style={{width:"100%",marginTop:12}} disabled={saving}>
                Start Game! ({ensureArray(game.words).length} words from {submittedCount}/{players.length} players)
              </Btn>
            )}
          </Card>
        )}
        {joined && game.phase==="words" && isAdmin && (
          <TurnOrderPreview order={ensureArray(game.turnOrder)} team1={game.team1} team2={game.team2} />
        )}

        {/* PLAYING */}
        {joined && game.phase==="playing" && (
          <div style={{animation:"fadeIn .4s ease"}}>
            <div style={{textAlign:"center",marginBottom:10}}>
              <RoundBadge round={game.currentRound||0} totalRounds={totalRounds} />
              <p style={{color:C.muted,fontSize:13,marginTop:5}}>Get through all the cards to finish the round!</p>
            </div>
            <Scoreboard team1={game.team1} team2={game.team2} />
            <Card style={{marginTop:14,textAlign:"center"}}>
              {currentTurn && (
                <div style={{marginBottom:14}}>
                  <div style={{fontSize:12,color:C.muted,marginBottom:3}}>Now playing</div>
                  <div style={{fontFamily:F.display,fontSize:21,color:currentTurn.team===1?C.accent:C.accent2}}>{currentTurn.playerName}</div>
                  <div style={{fontSize:12,color:C.muted}}>{currentTurn.team===1?game.team1.name:game.team2.name}</div>
                </div>
              )}
              <div style={{fontFamily:F.mono,fontSize:52,fontWeight:700,color:localTime<=5?C.danger:localTime<=10?C.warn:C.accent3,animation:game.turnActive&&localTime<=5?"pulse .5s infinite":"none",marginBottom:10,transition:"color .3s"}}>{localTime}s</div>
              <div style={{fontSize:12,color:C.muted,marginBottom:14}}>
                {roundWords.length} card{roundWords.length!==1?"s":""} left · Skips: {game.skipsUsed||0} (2 free)
              </div>

              {game.turnActive && (isMyTurn||amAdmin) && currentWord && (
                <div style={{background:`linear-gradient(135deg,${C.accent}22,${C.accent2}22)`,borderRadius:14,padding:"24px 18px",marginBottom:14,border:`2px solid ${C.accent}55`,animation:"fadeIn .3s ease"}}>
                  <div style={{fontSize:11,color:C.muted,marginBottom:5}}>THE WORD IS</div>
                  <div style={{fontFamily:F.display,fontSize:28,color:C.gold,textShadow:`0 0 18px ${C.gold}44`}}>{currentWord}</div>
                </div>
              )}
              {game.turnActive && !isMyTurn && !amAdmin && (
                <div style={{background:C.surface,borderRadius:14,padding:"24px 18px",marginBottom:14}}>
                  <div style={{fontSize:36,marginBottom:6}}>👀</div>
                  <div style={{color:C.muted}}>{currentTurn?.playerName} is playing...</div>
                </div>
              )}
              {!game.turnActive && (isMyTurn||amAdmin) && (
                <Btn onClick={startTurn} disabled={saving}>{isMyTurn?"Start My Turn!":`Start ${currentTurn?.playerName}'s Turn`}</Btn>
              )}
              {game.turnActive && (isMyTurn||amAdmin) && (
                <div style={{display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap"}}>
                  <Btn onClick={handleCorrect} color={C.success} disabled={saving}>✓ Rohan Approves (+2)</Btn>
                  <Btn onClick={handleSkip} color={C.warn} disabled={saving}>⏭ Skip {(game.skipsUsed||0)>=2?"(-1)":`(${2-(game.skipsUsed||0)} free)`}</Btn>
                  <Btn onClick={handleIncorrect} color={C.danger} disabled={saving}>✗ Rohan Disapproves</Btn>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ROUND END */}
        {joined && game.phase==="roundEnd" && (
          <Card glow style={{animation:"fadeIn .4s ease",textAlign:"center"}}>
            <div style={{fontSize:44,marginBottom:6}}>🎉</div>
            <h2 style={{fontFamily:F.display,color:C.gold,margin:"0 0 6px"}}>Round {(game.currentRound||0)+1} Complete!</h2>
            <p style={{color:C.muted,fontSize:13,marginBottom:18}}>All cards cleared! {(totalRounds-1)-(game.currentRound||0)} round{(totalRounds-1)-(game.currentRound||0)!==1?"s":""} left.</p>
            <Scoreboard team1={game.team1} team2={game.team2} />
            <RoundWordAudit logs={game.wordLog||[]} round={game.currentRound||0} />
            {isAdmin && (game.currentRound||0)<(totalRounds-1) && (
              <Btn onClick={nextRound} style={{marginTop:18}} disabled={saving}>Start Round {(game.currentRound||0)+2}</Btn>
            )}
          </Card>
        )}

        {/* GAME OVER */}
        {joined && game.phase==="gameOver" && (()=>{
          const tied=game.team1.score===game.team2.score;
          const t1W=game.team1.score>game.team2.score;
          const winner=t1W?game.team1.name:game.team2.name;
          const loser=t1W?game.team2.name:game.team1.name;
          return (
            <Card glow style={{animation:"fadeIn .5s ease",textAlign:"center"}}>
              <div style={{fontSize:56,marginBottom:6}}>🏆🎂🏆</div>
              <h2 style={{fontFamily:F.display,fontSize:26,margin:"0 0 4px",background:`linear-gradient(90deg,${C.gold},${C.accent})`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Game Over!</h2>
              <p style={{color:C.muted,fontSize:13,marginBottom:18}}>Happy 30th Birthday, Rohan! Final scores:</p>
              <Scoreboard team1={game.team1} team2={game.team2} />
              {tied?(
                <div style={{marginTop:18,fontFamily:F.display,fontSize:20,color:C.gold}}>It's a Tie! Rohan loves you both equally.</div>
              ):(
                <div style={{marginTop:18}}>
                  <div style={{fontFamily:F.display,fontSize:20,color:C.success,marginBottom:8}}>{winner} Wins! 🎉</div>
                  <div style={{fontFamily:F.display,fontSize:16,color:C.success}}>Rohan is proud of you!</div>
                  <div style={{fontFamily:F.display,fontSize:14,color:C.danger,marginTop:10,opacity:0.8}}>{loser} — Rohan is disappointed in you.</div>
                </div>
              )}
              <FullGameAudit logs={game.wordLog||[]} totalRounds={totalRounds} />
              {isAdmin && <Btn onClick={resetGame} color={C.muted} style={{marginTop:18}} disabled={saving}>Reset Game</Btn>}
            </Card>
          );
        })()}

        <div style={{textAlign:"center",marginTop:28,color:C.muted,fontSize:10}}>Made with {FISH} for Rohan's 30th</div>
      </div>
    </div>
  );
}
