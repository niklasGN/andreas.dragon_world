const SAVE_KEY = 'dragonworld.save.v1';
const SCORE_KEY = 'dragonworld.scores.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const Save = {
  load: () => read(SAVE_KEY, null),
  store: (data) => write(SAVE_KEY, data),
  clear: () => { try { localStorage.removeItem(SAVE_KEY); } catch { /* storage unavailable */ } },
  has: () => read(SAVE_KEY, null) !== null,
};

export const Scores = {
  all: () => read(SCORE_KEY, []),
  add(entry) {
    const list = read(SCORE_KEY, []);
    list.push({ ...entry, date: new Date().toISOString() });
    list.sort((a, b) => b.level - a.level || b.kills - a.kills);
    write(SCORE_KEY, list.slice(0, 10));
  },
  best: () => (read(SCORE_KEY, [])[0]?.level ?? 0),
};
