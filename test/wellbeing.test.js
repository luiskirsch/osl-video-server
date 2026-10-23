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
test("saved well-being rejects PATCH without changing mood, encrypted answers or notes",async t=>{
 const saved={uid:"owner",date:"2026-10-22",mood:4,note:{private:"encrypted-note"},wellbeing:wellbeing.seal("owner","2026-10-22",{anxiety:0,energy:8,sleep:5},secret)};
 const before=structuredClone(saved);
 const db={collection:()=>({doc:id=>({get:async()=>({exists:id==="owner_2026-10-22",data:()=>saved})})})};
 const app=express();app.use(express.json());app.use(require("../routes/wellbeing")({getDb:()=>db,ensureDb:()=>true,secret,today:()=>"2026-10-22",verifyFirebaseToken:async(req,res)=>{const uid=req.get("authorization");if(!uid)res.status(401).json({ok:false});return uid;}}));
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const call=(body,uid="owner")=>fetch(`http://127.0.0.1:${server.address().port}/therapy/paciente/humor/bem-estar`,{method:"PATCH",headers:{"Content-Type":"application/json",...(uid?{Authorization:uid}:{})},body:JSON.stringify(body)});
 assert.equal((await call({anxiety:0},null)).status,401);assert.equal((await call({sleep:8},"other")).status,409);
 for(const body of [{anxiety:10,energy:0,sleep:10},{anxiety:null,energy:null,sleep:null},{}]){const r=await call(body);assert.equal(r.status,409);assert.equal((await r.json()).error,"REGISTRO_JA_SALVO");}
 assert.deepEqual(saved,before);
});

test("daily check-in validates all answers and commits mood, encrypted wellbeing and note together",async t=>{
 const stored=new Map();let failCommit=false,commits=0,queue=Promise.resolve();
 const db={collection:name=>({doc:id=>({key:`${name}/${id||"history"}`})}),runTransaction:fn=>{
  const run=queue.then(async()=>{const writes=[];await fn({get:async ref=>({exists:stored.has(ref.key),data:()=>structuredClone(stored.get(ref.key))}),create:(ref,value)=>writes.push([ref.key,value])});if(failCommit)throw Error("offline");commits++;for(const [key,value] of writes)stored.set(key,value);});queue=run.catch(()=>{});return run;
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
 const before=structuredClone(current);
 for(const changed of [body,{...body,mood:2,note:"changed"},{mood:3}]){const r=await call(changed);assert.equal(r.status,409);assert.equal((await r.json()).error,"REGISTRO_JA_SALVO");}
 assert.deepEqual(stored.get("therapy_humor/owner_2026-10-22"),before);assert.equal(commits,1);
 const race=await Promise.all([call(body,"another-owner"),call({...body,mood:2},"another-owner")]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);assert.equal(commits,2);
});
