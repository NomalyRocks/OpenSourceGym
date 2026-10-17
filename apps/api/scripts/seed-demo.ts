/**
 * Demo data seed: wipes the target database and fills it with a believable
 * chain (3 gyms in Istanbul, owner, admins, staff, ~80 members with
 * subscriptions and entry history) for screenshots and UI work.
 *
 * Safety: refuses to run unless the database name in MONGODB_URI ends with
 * `-demo`, so a dev or production database can never be wiped by accident.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27018/opengym-demo \
 *   REDIS_URL=redis://127.0.0.1:6380/7 SMTP_HOST= \
 *   pnpm --filter @opengym/api seed:demo
 *
 * Every account signs in with DEMO_PASSWORD (default "demo1234"); the owner is
 * admin@opengym.local. Accounts flagged with MFA have no authenticator secret,
 * so they cannot sign in — they exist to populate the table.
 */
import { ObjectId } from "mongodb";

const DEMO_SUFFIX = "-demo";

function databaseNameOf(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

const databaseName = databaseNameOf(process.env.MONGODB_URI);
if (!databaseName || !databaseName.endsWith(DEMO_SUFFIX)) {
  console.error(
    `[seed-demo] Refusing to run: MONGODB_URI must name a database ending in "${DEMO_SUFFIX}" ` +
      `(got ${databaseName ? `"${databaseName}"` : "none"}). Nothing was touched.`,
  );
  process.exit(1);
}

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "demo1234";

// Imported after the guard: loading these modules reads the environment.
const [
  { auth },
  { db, mongoClient, userCollection, gymCollection },
  { connectRedis, redis },
  { ensureIndexes },
  { gateQrContent },
  { INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PHONE, runAsInitialAdminSeed },
] = await Promise.all([
  import("../src/auth.js"),
  import("../src/db.js"),
  import("../src/redis.js"),
  import("../src/indexes.js"),
  import("../src/gateQr.js"),
  import("../src/initialAdmin.js"),
]);
const { createHash, randomBytes } = await import("node:crypto");

// --- deterministic randomness: the same seed yields the same demo chain ---
let state = 20261016;
function random(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));
const pick = <T>(list: readonly T[]): T => list[int(0, list.length - 1)]!;
const chance = (p: number) => random() < p;

const DAY = 86_400_000;
const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

const FEMALE = [
  "Ayşe",
  "Fatma",
  "Zeynep",
  "Elif",
  "Merve",
  "Büşra",
  "Esra",
  "Selin",
  "Derya",
  "Gizem",
  "Hülya",
  "İpek",
  "Burcu",
  "Seda",
  "Ece",
  "Pınar",
  "Yasemin",
  "Cansu",
  "Nur",
  "Özlem",
  "Çağla",
  "Dilara",
  "Melike",
  "Sevgi",
];
const MALE = [
  "Mehmet",
  "Mustafa",
  "Ahmet",
  "Ali",
  "Hüseyin",
  "Emre",
  "Burak",
  "Can",
  "Cem",
  "Kerem",
  "Oğuz",
  "Serkan",
  "Murat",
  "Tolga",
  "Barış",
  "Onur",
  "Yusuf",
  "Furkan",
  "Berkay",
  "Gökhan",
  "Ümit",
  "Çağatay",
  "Efe",
  "Deniz",
];
const SURNAMES = [
  "Yılmaz",
  "Kaya",
  "Demir",
  "Şahin",
  "Çelik",
  "Yıldız",
  "Yıldırım",
  "Öztürk",
  "Aydın",
  "Özdemir",
  "Arslan",
  "Doğan",
  "Kılıç",
  "Aslan",
  "Çetin",
  "Kara",
  "Koç",
  "Kurt",
  "Özkan",
  "Şimşek",
  "Polat",
  "Erdoğan",
  "Güneş",
  "Aksoy",
  "Korkmaz",
  "Türk",
  "Bulut",
  "Tekin",
  "Ünal",
  "Işık",
];

const ASCII: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};
const slug = (value: string) =>
  value
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşüâîû]/g, (c) => ASCII[c] ?? c)
    .replace(/[^a-z0-9]/g, "");

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  const prefix = [530, 532, 533, 535, 536, 538, 541, 542, 543, 544, 551, 553][
    phoneCounter % 12
  ];
  return `${prefix}${String(1_000_000 + phoneCounter * 7919).slice(-7)}`;
}

const emails = new Set<string>();
function nextEmail(first: string, last: string): string {
  const base = `${slug(first)}.${slug(last)}`;
  let email = `${base}@example.com`;
  for (let n = 2; emails.has(email); n += 1) {
    email = `${base}${n}@example.com`;
  }
  emails.add(email);
  return email;
}

// --- wipe ---
await mongoClient.connect();
await connectRedis();
await db.dropDatabase();
const redisPath = new URL(process.env.REDIS_URL ?? "redis://localhost:6379")
  .pathname;
if (redisPath && redisPath !== "/" && redisPath !== "/0") {
  await redis.flushDb();
}
await ensureIndexes();
console.log(`[seed-demo] Wiped database "${databaseName}"`);

const ctx = await auth.$context;
const passwordHash = await ctx.password.hash(DEMO_PASSWORD);

interface NewUser {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  role: "owner" | "admin" | "staff" | "member";
  gymIds?: string[];
  createdAt: Date;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
}

/**
 * Creates a user through BetterAuth's own adapter (so the signup hooks, phone
 * normalization and ObjectId handling run) and links a credential account with
 * the real password hasher. Goes around the HTTP signup endpoint on purpose:
 * that one rate-limits and mails an OTP per account.
 */
async function createUser(input: NewUser): Promise<string> {
  const isOwner = input.role === "owner";
  const email = input.email ?? nextEmail(input.firstName, input.lastName);
  const create = () =>
    ctx.internalAdapter.createUser({
      email,
      name: `${input.firstName} ${input.lastName}`,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: isOwner ? INITIAL_ADMIN_PHONE : (input.phone ?? nextPhone()),
      dataProcessingAccepted: true,
      privacyAccepted: true,
      emailVerified: false,
    } as never);
  const created = await (isOwner ? runAsInitialAdminSeed(create) : create());
  const id = String((created as { id: unknown }).id);
  await ctx.internalAdapter.linkAccount({
    userId: id,
    providerId: "credential",
    accountId: id,
    password: passwordHash,
  } as never);
  await userCollection().updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        role: input.role,
        gymIds: input.gymIds ?? [],
        mustChangePassword: false,
        emailVerified: input.emailVerified,
        twoFactorEnabled: input.twoFactorEnabled,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    },
  );
  return id;
}

// --- owner ---
const ownerId = await createUser({
  firstName: "Salon",
  lastName: "Yöneticisi",
  email: INITIAL_ADMIN_EMAIL,
  role: "owner",
  createdAt: daysAgo(560),
  emailVerified: true,
  twoFactorEnabled: false,
});

// --- gyms ---
const GYM_DEFS = [
  { name: "OpenGym Kadıköy", lat: 40.9903, lng: 29.0291, capacity: 120 },
  { name: "OpenGym Beşiktaş", lat: 41.0422, lng: 29.0083, capacity: 150 },
  { name: "OpenGym Levent", lat: 41.0811, lng: 29.0114, capacity: 90 },
];
const gyms: { id: ObjectId; name: string; lat: number; lng: number }[] = [];
for (const [index, def] of GYM_DEFS.entries()) {
  const _id = new ObjectId();
  await gymCollection().insertOne({
    _id,
    name: def.name,
    location: { lat: def.lat, lng: def.lng, radiusM: 250 },
    capacity: def.capacity,
    autoExitHours: 3,
    active: true,
    createdBy: ownerId,
    createdAt: daysAgo(540 - index * 90),
  });
  gyms.push({ id: _id, name: def.name, lat: def.lat, lng: def.lng });
}
const gymHex = (index: number) => gyms[index]!.id.toHexString();

// --- turnstile devices: one entry and one exit per gym ---
const devices: { id: string; gymId: ObjectId; direction: "in" | "out" }[] = [];
for (const gym of gyms) {
  for (const direction of ["in", "out"] as const) {
    const token = `og_${randomBytes(24).toString("hex")}`;
    const inserted = await db.collection("devices").insertOne({
      name: `${gym.name.replace("OpenGym ", "")} ${direction === "in" ? "Giriş" : "Çıkış"}`,
      direction,
      gymId: gym.id.toHexString(),
      tokenHash: createHash("sha256").update(token).digest("hex"),
      createdAt: gym.id.getTimestamp(),
      createdBy: ownerId,
      lastSeenAt: null,
    });
    devices.push({
      id: inserted.insertedId.toHexString(),
      gymId: gym.id,
      direction,
    });
  }
}
void gateQrContent; // qrContent is derived on read; nothing is stored

// --- admins and staff ---
const staffIds: string[] = [];
const staffDefs: Omit<NewUser, "createdAt">[] = [
  {
    firstName: "Elif",
    lastName: "Aydın",
    role: "admin",
    gymIds: [gymHex(0), gymHex(1)],
    emailVerified: true,
    twoFactorEnabled: false,
  },
  {
    firstName: "Kerem",
    lastName: "Arslan",
    role: "admin",
    gymIds: [gymHex(2)],
    emailVerified: true,
    twoFactorEnabled: false,
  },
  {
    firstName: "Selin",
    lastName: "Çelik",
    role: "staff",
    gymIds: [gymHex(0)],
    emailVerified: true,
    twoFactorEnabled: false,
  },
  {
    firstName: "Oğuz",
    lastName: "Kaya",
    role: "staff",
    gymIds: [gymHex(0), gymHex(1)],
    emailVerified: true,
    twoFactorEnabled: true,
  },
  {
    firstName: "Dilara",
    lastName: "Şahin",
    role: "staff",
    gymIds: [gymHex(1)],
    emailVerified: true,
    twoFactorEnabled: false,
  },
  {
    firstName: "Tolga",
    lastName: "Demir",
    role: "staff",
    gymIds: [gymHex(2)],
    emailVerified: false,
    twoFactorEnabled: false,
  },
];
for (const [index, def] of staffDefs.entries()) {
  staffIds.push(
    await createUser({ ...def, createdAt: daysAgo(500 - index * 40) }),
  );
}

// --- members ---
interface Period {
  startsAt: Date;
  endsAt: Date;
}
const MEMBER_COUNT = 80;

/** Back-to-back periods from `first`; `state` decides where the history stops. */
function buildPeriods(
  first: Date,
  state: "active" | "expired" | "none",
): Period[] {
  if (state === "none" || first >= now) return [];
  const periods: Period[] = [];
  let start = first;
  for (;;) {
    const months = pick([1, 1, 3, 3, 6, 12]);
    const end = addMonths(start, months);
    if (state === "active") {
      periods.push({ startsAt: start, endsAt: end });
      if (end > now) return periods;
    } else {
      if (end > daysAgo(2)) break;
      periods.push({ startsAt: start, endsAt: end });
      if (chance(0.4)) break;
    }
    start = end;
  }
  return periods;
}

const memberRows: {
  id: string;
  name: string;
  gymIds: ObjectId[];
  periods: Period[];
}[] = [];
const subscriptions: Record<string, unknown>[] = [];

for (let i = 0; i < MEMBER_COUNT; i += 1) {
  const female = chance(0.5);
  const firstName = pick(female ? FEMALE : MALE);
  const lastName = pick(SURNAMES);
  // Newer members are more common: the chain is growing.
  const ageDays = Math.floor(Math.pow(random(), 1.4) * 540) + 1;
  const createdAt = daysAgo(ageDays);
  const roll = random();
  const state: "active" | "expired" | "none" =
    roll < 0.55 ? "active" : roll < 0.8 ? "expired" : "none";
  const id = await createUser({
    firstName,
    lastName,
    role: "member",
    createdAt,
    emailVerified: chance(0.85),
    twoFactorEnabled: chance(0.15),
  });
  const gymCount = chance(0.7) ? 1 : chance(0.7) ? 2 : 3;
  const gymIds = [...gyms.map((g) => g.id)]
    .sort(() => random() - 0.5)
    .slice(0, gymCount);
  const firstStart = new Date(createdAt.getTime() + int(0, 10) * DAY);
  const periods = buildPeriods(firstStart, state);
  for (const period of periods) {
    subscriptions.push({
      userId: new ObjectId(id),
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      gymIds,
      note: chance(0.1)
        ? pick(["Cash payment", "Student discount", "Campaign"])
        : null,
      createdBy: pick([ownerId, ...staffIds]),
      createdAt: period.startsAt,
    });
  }
  memberRows.push({ id, name: `${firstName} ${lastName}`, gymIds, periods });
}
await db.collection("subscriptions").insertMany(subscriptions as never[]);

// --- entry history: the last 30 days, members who held a period that day ---
const entryEvents: Record<string, unknown>[] = [];
const deviceFor = (gymId: ObjectId, direction: "in" | "out") =>
  devices.find((d) => d.gymId.equals(gymId) && d.direction === direction)!;
const HOURS = [6, 7, 7, 8, 8, 9, 12, 13, 17, 18, 18, 19, 19, 20, 21];

for (const member of memberRows) {
  for (let day = 30; day >= 0; day -= 1) {
    const dayStart = daysAgo(day);
    const covered = member.periods.some(
      (p) => p.startsAt <= dayStart && p.endsAt > dayStart,
    );
    if (!covered || !chance(0.28)) continue;
    const gym = pick(member.gymIds);
    const at = new Date(dayStart);
    at.setHours(pick(HOURS), int(0, 59), int(0, 59), 0);
    if (at > now) continue;
    const entryDevice = deviceFor(gym, "in");
    const exitDevice = deviceFor(gym, "out");
    const gymDoc = gyms.find((g) => g.id.equals(gym))!;
    entryEvents.push({
      gymId: gym.toHexString(),
      deviceId: entryDevice.id,
      deviceName: `${gymDoc.name.replace("OpenGym ", "")} Giriş`,
      userId: member.id,
      memberName: member.name,
      allowed: true,
      reason: null,
      at,
      direction: "in",
      distanceM: int(5, 90),
    });
    const out = new Date(at.getTime() + int(40, 110) * 60_000);
    if (out < now) {
      entryEvents.push({
        gymId: gym.toHexString(),
        deviceId: exitDevice.id,
        deviceName: `${gymDoc.name.replace("OpenGym ", "")} Çıkış`,
        userId: member.id,
        memberName: member.name,
        allowed: true,
        reason: null,
        at: out,
        direction: "out",
        distanceM: int(5, 90),
      });
    }
  }
}

// A few refused scans from members whose period lapsed.
for (const member of memberRows
  .filter((m) => m.periods.length > 0)
  .slice(0, 12)) {
  const last = member.periods[member.periods.length - 1]!;
  if (last.endsAt > now) continue;
  const gym = member.gymIds[0]!;
  const gymDoc = gyms.find((g) => g.id.equals(gym))!;
  entryEvents.push({
    gymId: gym.toHexString(),
    deviceId: deviceFor(gym, "in").id,
    deviceName: `${gymDoc.name.replace("OpenGym ", "")} Giriş`,
    userId: member.id,
    memberName: member.name,
    allowed: false,
    reason: "NO_ACTIVE_SUBSCRIPTION",
    at: daysAgo(int(1, 20)),
    direction: "in",
    distanceM: int(5, 90),
  });
}
entryEvents.sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
if (entryEvents.length > 0) {
  await db.collection("entry_events").insertMany(entryEvents as never[]);
}

// --- a few audit rows so the audit page is not empty ---
const auditRows = [
  ...gyms.map((gym, index) => ({
    actorId: ownerId,
    actorEmail: INITIAL_ADMIN_EMAIL,
    action: "gym-created",
    targetId: gym.id.toHexString(),
    details: { name: gym.name },
    gymId: gym.id.toHexString(),
    at: daysAgo(540 - index * 90),
  })),
  ...subscriptions.slice(-20).map((sub) => ({
    actorId: ownerId,
    actorEmail: INITIAL_ADMIN_EMAIL,
    action: "subscription-created",
    targetId: String(sub.userId),
    details: null,
    gymId: (sub.gymIds as ObjectId[])[0]!.toHexString(),
    at: sub.createdAt as Date,
  })),
];
await db.collection("audit_logs").insertMany(auditRows as never[]);

const byStatus = { active: 0, expired: 0, none: 0 };
for (const m of memberRows) {
  const last = m.periods[m.periods.length - 1];
  byStatus[!last ? "none" : last.endsAt > now ? "active" : "expired"] += 1;
}
console.log(
  `[seed-demo] Created owner, ${staffIds.length} admin/staff, ${memberRows.length} members ` +
    `(active ${byStatus.active}, expired ${byStatus.expired}, none ${byStatus.none}), ` +
    `${gyms.length} gyms, ${devices.length} devices, ${subscriptions.length} subscriptions, ` +
    `${entryEvents.length} entry events.`,
);
console.log(`[seed-demo] Sign in as ${INITIAL_ADMIN_EMAIL} / ${DEMO_PASSWORD}`);

await redis.quit();
await mongoClient.close();
