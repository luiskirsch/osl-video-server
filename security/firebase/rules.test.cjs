"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, collection, getDoc, getDocs, getCountFromServer, setDoc, updateDoc, deleteDoc, setLogLevel } = require("firebase/firestore");
const { ref, uploadBytes, getMetadata, listAll, deleteObject } = require("firebase/storage");
setLogLevel("silent");

const clinicalCollections = ["therapists", "therapy_patient_accounts", "therapy_patients", "therapy_sessions",
  "therapy_notes", "therapy_patient_notes", "therapy_audit", "audit_logs", "therapy_humor",
  "therapy_chat_threads", "therapy_colaboradores", "therapy_estudantes", "nr1_campaigns",
  "therapy_deletion_requests", "future_clinical_collection"];

test("published shared rules and dedicated clinical rules deny direct clinical access", async t => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "Use npm run test:emulators; live Firebase is forbidden");
  assert.ok(process.env.FIREBASE_STORAGE_EMULATOR_HOST, "Storage emulator required");
  for (const mode of ["shared", "staging", "dedicated"]) {
    await t.test(mode, async sub => {
      const env = await initializeTestEnvironment({
        projectId: "demo-preludio-" + mode,
        firestore: { rules: fs.readFileSync(path.join(__dirname, mode === "shared" ? "shared.firestore.rules" : mode === "staging" ? "staging.firestore.rules" : "firestore.rules"), "utf8") },
        storage: { rules: fs.readFileSync(path.join(__dirname, "storage.rules"), "utf8") }
      });
      sub.after(() => env.cleanup());
      await env.withSecurityRulesDisabled(async context => {
        for (const name of clinicalCollections) {
          await setDoc(doc(context.firestore(), name, "synthetic-record"), { uid: "patient-a", therapistUid: "therapist-a", marker: "synthetic-only" });
        }
        await setDoc(doc(context.firestore(), "therapy_sessions/synthetic-record/notes/synthetic-note"), { marker: "synthetic-only" });
        await setDoc(doc(context.firestore(), "config/public-test"), { theme: "test" });
        await uploadBytes(ref(context.storage(), "clinical/synthetic-record.txt"), new Uint8Array([1, 2, 3]));
      });
      for (const [actor, context] of [
        ["anonymous", env.unauthenticatedContext()],
        ["patient-a", env.authenticatedContext("patient-a", { email_verified: true })],
        ["therapist-a", env.authenticatedContext("therapist-a", { email_verified: true })],
        ["game-user", env.authenticatedContext("game-user", { email_verified: true })]
      ]) {
        await sub.test(actor, async () => {
          const db = context.firestore();
          for (const name of clinicalCollections) {
            const record = doc(db, name, "synthetic-record");
            await assertFails(getDoc(record));
            await assertFails(getDocs(collection(db, name)));
            await assertFails(getCountFromServer(collection(db, name)));
            await assertFails(setDoc(doc(db, name, "synthetic-new"), { uid: "patient-a" }));
            await assertFails(updateDoc(record, { marker: "unauthorized" }));
            await assertFails(deleteDoc(record));
          }
          await assertFails(getDoc(doc(db, "therapy_sessions/synthetic-record/notes/synthetic-note")));
          const file = ref(context.storage(), "clinical/synthetic-record.txt");
          await assertFails(uploadBytes(file, new Uint8Array([1, 2, 3])));
          await assertFails(getMetadata(file));
          await assertFails(listAll(ref(context.storage(), "clinical")));
          await assertFails(deleteObject(file));
        });
      }
      // Positive control: the shared snapshot still allows the game's public config.
      if (mode !== "dedicated") {
        await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), "config/public-test")));
        await sub.test("legitimate game creation and profile access survive clinical isolation", async () => {
          const gameDb = env.authenticatedContext("game-positive-control").firestore();
          const profile = doc(gameDb, "users/game-positive-control");
          await assertSucceeds(setDoc(profile, { displayName: "SYNTHETIC TEST" }));
          await assertSucceeds(updateDoc(profile, { displayName: "UPDATED SYNTHETIC TEST" }));
          await assertFails(updateDoc(profile, { coins: 100 }));
          await assertSucceeds(setDoc(doc(gameDb, "salas/synthetic-room"), { hostId: "game-positive-control" }));
          await assertSucceeds(setDoc(doc(gameDb, "salas/synthetic-room/players/game-positive-control"), { name: "SYNTHETIC TEST" }));
        });
      }
    });
  }
});
