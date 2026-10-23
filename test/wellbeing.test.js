"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const {once}=require("node:events");
const wellbeing=require("../services/wellbeing");
const secret="synthetic-wellbeing-secret-32-characters";
test("well-being validates optional scales and binds ciphertext to user and day",()=>{
 assert.deepEqual(wellbeing.normalize({anxiety:0,energy:10}),{anxiety:0,energy:10,sleep:null});
 for(const input of [{anxiety:-1},{sleep:11},{energy:1.5},{sleep:"5"},{date:"2026-10-22"},[]])assert.throws(()=>wellbeing.normalize(input));
 const sealed=wellbeing.seal("owner","2026-10-22",{anxiety:0,energy:4,sleep:8},secret);
 assert.equal(wellbeing.open("owner","2026-10-22",sealed,secret).anxiety,0);
 assert.throws(()=>wellbeing.open("other","2026-10-22",sealed,secret));assert.throws(()=>wellbeing.open("owner","2026-10-21",sealed,secret));
});
test("well-being update requires owner's daily mood and preserves mood, notes and other days",async t=>{
 const data=new Map([["owner_2026-10-22",{uid:"owner",date:"2026-10-22",mood:4,note:{private:"encrypted-note"}}]]);
 const db={collection:()=>({doc:id=>({id})}),runTransaction:async fn=>fn({get:async ref=>({exists:data.has(ref.id),data:()=>structuredClone(data.get(ref.id))}),update:(ref,patch)=>data.set(ref.id,{...data.get(ref.id),...patch})})};
 const app=express();app.use(express.json());app.use(require("../routes/wellbeing")({getDb:()=>db,ensureDb:()=>true,secret,today:()=>"2026-10-22",verifyFirebaseToken:async(req,res)=>{const uid=req.get("authorization");if(!uid)res.status(401).json({ok:false});return uid;}}));
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const call=(body,uid="owner")=>fetch(`http://127.0.0.1:${server.address().port}/therapy/paciente/humor/bem-estar`,{method:"PATCH",headers:{"Content-Type":"application/json",...(uid?{Authorization:uid}:{})},body:JSON.stringify(body)});
 assert.equal((await call({anxiety:0},null)).status,401);assert.equal((await call({sleep:8},"other")).status,409);
 assert.equal((await call({sleep:99})).status,400);assert.equal((await call({anxiety:0,energy:7,sleep:8})).status,200);
 const saved=data.get("owner_2026-10-22");assert.equal(saved.mood,4);assert.deepEqual(saved.note,{private:"encrypted-note"});
 assert.equal(wellbeing.open("owner","2026-10-22",saved.wellbeing,secret).sleep,8);assert.equal(data.size,1);
 assert.equal((await call({anxiety:null,energy:null,sleep:null})).status,200);
 assert.equal(wellbeing.open("owner","2026-10-22",data.get("owner_2026-10-22").wellbeing,secret).sleep,null);
});

test("daily check-in validates all answers and commits mood, encrypted wellbeing and note together",async t=>{
 const stored=new Map();let failCommit=false,commits=0;
 const db={collection:name=>({doc:id=>({key:`${name}/${id||"history"}`})}),batch:()=>{
  const writes=[];return {set:(ref,value)=>writes.push([ref.key,value]),commit:async()=>{if(failCommit)throw Error("offline");commits++;for(const [key,value] of writes)stored.set(key,value);}};
 }};
 const app=express();app.use(express.json());app.use(require("../routes/wellbeing")({getDb:()=>db,ensureDb:()=>true,secret,today:()=>"2026-10-22",sealMoodNote:(uid,note)=>({encryptedFor:uid,textLength:note.length}),fieldValue:{delete:()=>"delete",serverTimestamp:()=>123},verifyFirebaseToken:async(req,res)=>{const uid=req.get("authorization");if(!uid)res.status(401).json({ok:false});return uid;}}));
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const call=(body,uid="owner")=>fetch(`http://127.0.0.1:${server.address().port}/therapy/paciente/humor`,{method:"POST",headers:{"Content-Type":"application/json",...(uid?{Authorization:uid}:{})},body:JSON.stringify(body)});
 const body={mood:4,note:"private observation",wellbeing:{anxiety:0,energy:8,sleep:5}};
 assert.equal((await call(body,null)).status,401);
 for(const invalid of [{...body,mood:9},{...body,wellbeing:{sleep:8}},{...body,wellbeing:{anxiety:0,energy:11,sleep:5}},{...body,note:"x".repeat(601)}])assert.equal((await call(invalid)).status,400);
 assert.equal(stored.size,0);assert.equal(commits,0);
 failCommit=true;assert.equal((await call(body)).status,503);assert.equal(stored.size,0);
 failCommit=false;const result=await call(body);assert.equal(result.status,200);assert.deepEqual((await result.json()).wellbeing,body.wellbeing);
 const current=stored.get("therapy_humor/owner_2026-10-22");assert.equal(current.uid,"owner");assert.equal(current.mood,4);assert.equal(commits,1);
 assert.deepEqual(wellbeing.open("owner","2026-10-22",current.wellbeing,secret),body.wellbeing);
 assert.equal(JSON.stringify(current).includes(body.note),false);assert.equal(stored.size,2);
 // Cached older clients remain compatible without deleting existing metrics.
 assert.equal((await call({mood:3})).status,200);
});
