'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const accountState = require('../services/accountState');

class FakeSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.path.split('/').at(-1);
    this.exists = value !== undefined;
    this._value = value;
  }

  data() {
    return this._value;
  }
}

class FakeCollection {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new FakeRef(this.db, `${this.path}/${id}`);
  }
}

class FakeRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  collection(name) {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }

  async get() {
    return new FakeSnapshot(this, this.db.store.get(this.path));
  }

  async set(data, options) {
    this.db.write(this.path, data, options);
  }
}

class FakeDb {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  write(path, data, options = {}) {
    const current = options.merge ? (this.store.get(path) || {}) : {};
    this.store.set(path, materialize(data, current));
  }

  async runTransaction(callback) {
    const writes = [];
    const tx = {
      get: async ref => new FakeSnapshot(ref, this.store.get(ref.path)),
      set: (ref, data, options) => writes.push({ ref, data, options }),
    };
    const result = await callback(tx);
    for (const write of writes) this.write(write.ref.path, write.data, write.options);
    return result;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function materialize(next, current) {
  if (isPlainObject(next) && Object.hasOwn(next, '__increment')) {
    return (Number(current) || 0) + next.__increment;
  }
  if (isPlainObject(next) && next.__serverTimestamp) {
    return new Date('2026-08-15T12:00:00.000Z');
  }
  if (!isPlainObject(next)) return next;

  const output = isPlainObject(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(next)) {
    output[key] = materialize(value, output[key]);
  }
  return output;
}

const fakeFieldValue = {
  increment: amount => ({ __increment: amount }),
  serverTimestamp: () => ({ __serverTimestamp: true }),
};

test('AccountSnapshot v1 normaliza identidade, nível, carteira e atividade', () => {
  const lastSession = {
    roomId: 'sala-1',
    sessionId: 'sessao-1',
    playedAt: 1_723_722_000_000,
    sessionAt: 1_723_722_000_000,
    playerCount: 4,
  };
  const account = accountState.buildAccountSnapshot({
    uid: 'uid-1',
    claims: { email: 'CLAIM@EXAMPLE.COM', name: 'Nome do token' },
    user: {
      displayName: 'Luis',
      username: 'luis',
      bio: 'Bio',
      avatar: { kind: 'image', url: 'https://img/avatar.png', emoji: '🌙', color: '#123456' },
      xp: 145,
      coins: 7,
      dailyStreak: 3,
      achievements: { first: true, second: true },
      stats: { gamesPlayed: 9, wins: 2, dailyRitualsCompleted: 4 },
      reputation: {
        score: 175,
        totalSessions: 9,
        totalReactions: 20,
        topReactorCount: 2,
        dailyRitualsCompleted: 3,
      },
      friends: ['u2', 'u2', 'u3'],
      incomingRequests: ['u4'],
      outgoingRequests: ['u5'],
      activeSession: { type: 'duo', roomId: 'room-active', sessionId: 'session-active' },
    },
    lastSession,
  });

  assert.deepEqual(Object.keys(account), [
    'schemaVersion', 'uid', 'profile', 'progression', 'wallet', 'reputation', 'social', 'activity',
  ]);
  assert.equal(account.schemaVersion, 1);
  assert.deepEqual(account.profile, {
    displayName: 'Luis',
    username: 'luis',
    email: 'claim@example.com',
    bio: 'Bio',
    avatar: { kind: 'image', url: 'https://img/avatar.png', emoji: '🌙', color: '#123456' },
  });
  assert.deepEqual({
    xp: account.progression.xp,
    level: account.progression.level,
    title: account.progression.title,
    levelXp: account.progression.levelXp,
    nextLevelXp: account.progression.nextLevelXp,
    xpIntoLevel: account.progression.xpIntoLevel,
    xpNeededForLevel: account.progression.xpNeededForLevel,
    progressPct: account.progression.progressPct,
  }, {
    xp: 145,
    level: 2,
    title: 'Iniciado',
    levelXp: 50,
    nextLevelXp: 200,
    xpIntoLevel: 95,
    xpNeededForLevel: 150,
    progressPct: 63,
  });
  assert.equal(account.progression.stats.dailyRitualsCompleted, 4);
  assert.deepEqual(account.wallet, { coins: 7 });
  assert.equal(account.reputation.tier, 'Engajado');
  assert.deepEqual(account.social, { friendsCount: 2, incomingCount: 1, outgoingCount: 1 });
  assert.equal(account.activity.activeSession.roomId, 'room-active');
  assert.deepEqual(account.activity.lastSession, lastSession);
});

test('avatar usa perfil legado e claims somente como fallbacks', () => {
  assert.deepEqual(
    accountState.resolveAvatar({}, { photoBase64: 'data:image/png;base64,abc', avatarEmoji: '🕯️' }, { picture: 'claims.png' }),
    {
      kind: 'image',
      url: 'data:image/png;base64,abc',
      emoji: '🕯️',
      color: '#342718',
    },
  );
  assert.equal(accountState.resolveAvatar({}, {}, { picture: 'claims.png' }).url, 'claims.png');
  assert.deepEqual(
    accountState.resolveAvatar({
      avatar: { kind: 'emoji', url: null, emoji: '🌒', color: '#223344' },
      avatarPhotoUrl: 'legacy.png',
    }, {}, { picture: 'claims.png' }),
    { kind: 'emoji', url: null, emoji: '🌒', color: '#223344' },
  );
});

test('streak diário incrementa apenas em dias consecutivos', () => {
  assert.equal(accountState.nextDailyStreak({
    dailyStreak: 4,
    lastDailyCompletedDate: '2026-08-14',
  }, '2026-08-15'), 5);
  assert.equal(accountState.nextDailyStreak({
    dailyStreak: 4,
    lastDailyCompletedDate: '2026-08-12',
  }, '2026-08-15'), 1);
});

test('conclusão diária é transacional, premia uma vez e preserva stats', async () => {
  const db = new FakeDb({
    'daily_ritual/2026-08-15': { completionCount: 4 },
    'users/uid-1': {
      xp: 145,
      dailyStreak: 2,
      lastDailyReward: '2026-08-14',
      stats: { gamesPlayed: 3, dailyRitualsCompleted: 2 },
    },
  });
  const daily = { date: '2026-08-15', bonusXp: 50, cardTitle: 'Ritual' };

  const first = await accountState.completeDailyRitual({
    db,
    uid: 'uid-1',
    daily,
    now: new Date('2026-08-15T12:00:00.000Z'),
    fieldValue: fakeFieldValue,
  });
  assert.deepEqual({
    alreadyCompleted: first.alreadyCompleted,
    xpAwarded: first.xpAwarded,
    completionCount: first.completionCount,
    streak: first.streak,
  }, {
    alreadyCompleted: false,
    xpAwarded: 50,
    completionCount: 5,
    streak: 3,
  });
  assert.equal(db.store.get('users/uid-1').xp, 195);
  assert.equal(db.store.get('users/uid-1').stats.gamesPlayed, 3);
  assert.equal(db.store.get('users/uid-1').stats.dailyRitualsCompleted, 3);
  assert.equal(db.store.get('daily_ritual/2026-08-15').completionCount, 5);

  const second = await accountState.completeDailyRitual({
    db,
    uid: 'uid-1',
    daily,
    fieldValue: fakeFieldValue,
  });
  assert.equal(second.alreadyCompleted, true);
  assert.equal(second.xpAwarded, 0);
  assert.equal(second.completionCount, 5);
  assert.equal(db.store.get('users/uid-1').xp, 195);
  assert.equal(db.store.get('users/uid-1').stats.dailyRitualsCompleted, 3);
});

test('ensure cria raiz canônica sem substituir dados existentes', async () => {
  const db = new FakeDb({
    'user_profiles/uid-new': {
      displayName: 'Perfil legado',
      photoBase64: 'data:image/png;base64,legacy',
    },
  });

  const account = await accountState.ensureAccountSnapshot({
    db,
    uid: 'uid-new',
    claims: { email: 'new@example.com', name: 'Nome do token' },
    userData: {},
  });

  const persisted = db.store.get('users/uid-new');
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.uid, 'uid-new');
  assert.equal(persisted.userId, 'uid-new');
  assert.equal(persisted.xp, 0);
  assert.equal(persisted.coins, 0);
  assert.equal(persisted.email, 'new@example.com');
  assert.equal(persisted.displayName, 'Nome do token');
  assert.equal(persisted.avatar.url, 'data:image/png;base64,legacy');
  assert.deepEqual(persisted.friends, []);
  assert.deepEqual(persisted.incomingRequests, []);
  assert.deepEqual(persisted.outgoingRequests, []);
  assert.deepEqual(persisted.stats, { gamesPlayed: 0, wins: 0 });
  assert.equal(account.profile.avatar.url, 'data:image/png;base64,legacy');
  assert.equal(account.progression.level, 1);
});
