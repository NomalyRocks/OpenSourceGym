import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import {
  findActivePhoneConflictUserIds,
  PHONE_CONFLICT_COLLECTION,
} from "../phoneBackfill.js";
import { tryNormalizePhoneToE164 } from "../phone.js";
import { buildUserSearchFilter, USER_SEARCH_LIMIT } from "../userSearch.js";

const mongoUri = process.env.TEST_MONGODB_URI;

test(
  "member search partially matches first name, last name, full name, email, and phone",
  { skip: mongoUri ? false : "TEST_MONGODB_URI is not defined" },
  async () => {
    const client = new MongoClient(mongoUri!);
    const database = client.db(
      `opengym_search_${randomUUID().replaceAll("-", "")}`,
    );
    const users = database.collection("user");
    const duplicateAId = new ObjectId();
    const duplicateBId = new ObjectId();

    try {
      await client.connect();
      await users.insertMany([
        {
          name: "Ayşe Yılmaz",
          firstName: "Ayşe",
          lastName: "Yılmaz",
          email: "ayse.yilmaz@example.com",
          phone: "+905301234567",
          phoneE164: "+905301234567",
        },
        {
          name: "Mehmet Kaya",
          firstName: "Mehmet",
          lastName: "Kaya",
          email: "mehmet@example.com",
          phone: "+905551112233",
          phoneE164: "+905551112233",
        },
        {
          _id: duplicateAId,
          name: "Legacy Bir",
          firstName: "Legacy",
          lastName: "Bir",
          email: "legacy-one@example.com",
          phone: "532 123 45 67",
        },
        {
          _id: duplicateBId,
          name: "Legacy İki",
          firstName: "Legacy",
          lastName: "İki",
          email: "legacy-two@example.com",
          phone: "+90 (532) 123-45-67",
        },
      ]);
      await database.collection(PHONE_CONFLICT_COLLECTION).insertOne({
        _id: "+905321234567" as never,
        phoneE164: "+905321234567",
        active: true,
        users: [
          { userId: duplicateAId.toString() },
          { userId: duplicateBId.toString() },
        ],
        firstDetectedAt: new Date(),
      });

      async function emails(query: string): Promise<string[]> {
        const phoneE164 = tryNormalizePhoneToE164(query);
        const conflictUserIds = phoneE164
          ? await findActivePhoneConflictUserIds(phoneE164, database)
          : [];
        const docs = await users
          .find(buildUserSearchFilter(query, conflictUserIds))
          .limit(USER_SEARCH_LIMIT)
          .toArray();
        return docs.map((doc) => String(doc.email)).sort();
      }

      assert.deepEqual(await emails("AYŞ"), ["ayse.yilmaz@example.com"]);
      assert.deepEqual(await emails("yıl"), ["ayse.yilmaz@example.com"]);
      assert.deepEqual(await emails("Ayşe Yıl"), ["ayse.yilmaz@example.com"]);
      assert.deepEqual(await emails("Ayşe Kaya"), []);
      assert.deepEqual(await emails("yilmaz@example"), [
        "ayse.yilmaz@example.com",
      ]);
      assert.deepEqual(await emails("(530) 123"), ["ayse.yilmaz@example.com"]);
      assert.deepEqual(await emails("05301234567"), [
        "ayse.yilmaz@example.com",
      ]);
      assert.deepEqual(await emails("(0530) 123-45-67"), [
        "ayse.yilmaz@example.com",
      ]);
      assert.deepEqual(await emails("+905321234567"), [
        "legacy-one@example.com",
        "legacy-two@example.com",
      ]);
      assert.deepEqual(await emails("+90532123456x"), []);
      assert.deepEqual(await emails("legacy-one@example"), [
        "legacy-one@example.com",
      ]);
      assert.deepEqual(await emails("bulunmaz1"), []);

      await users.insertMany(
        Array.from({ length: USER_SEARCH_LIMIT + 5 }, (_, index) => ({
          name: `Limit Üyesi ${index}`,
          firstName: "Limit",
          lastName: `Üyesi ${index}`,
          email: `limit-${index}@example.com`,
          phone: `+90540${String(index).padStart(7, "0")}`,
        })),
      );
      assert.equal((await emails("Limit")).length, USER_SEARCH_LIMIT);
    } finally {
      await database.dropDatabase();
      await client.close();
    }
  },
);
