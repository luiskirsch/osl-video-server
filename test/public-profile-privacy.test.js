"use strict";
process.env.ACCESS_TOKEN_SECRET = "test-only-public-profile-photo-key-000000000000";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const firestore = require("../services/firestore");
const records = new Map(); const queries=[];
const database = { collection: name => {
  assert.equal(name,"therapists");const filters=[];
  const query={where(key,op,value){assert.equal(op,"==");filters.push([key,value]);return query;},limit(){return query;},async get(){
    queries.push([...filters]);const docs=[...records].filter(([id,data])=>filters.every(([key,value])=>typeof key==="string"?data[key]===value:id===value)).map(([id,data])=>({id,data:()=>data}));
    return {docs,empty:!docs.length,forEach:fn=>docs.forEach(fn)};
  }}; return query;
} };
// Actual registered HTTP handlers, with only the Firestore transport replaced.
const originalDb=firestore.getDb,originalEnsure=firestore.ensureDb;
firestore.getDb=()=>database;firestore.ensureDb=()=>true;
const router=require("../routes/therapy");
firestore.getDb=originalDb;firestore.ensureDb=originalEnsure;

test("public profile privacy applies at query, detail, photo and identifier boundaries", async t=>{
  const active={displayName:"Synthetic professional",verificationStatus:"verified",plano:"pro",adminDirectoryVisible:false,publicSchedulingEnabled:true,publicSchedulingSlug:"published-profile",photoBase64:Buffer.from("synthetic-image").toString("base64"),photoMime:"image/png",numeroConselho:"04/12345"};
  records.set("firebase-active-uid",active);
  records.set("firebase-disabled-uid",{...active,publicSchedulingEnabled:false,publicSchedulingSlug:"disabled-profile"});
  records.set("firebase-missing-consent",{...active,publicSchedulingEnabled:undefined,publicSchedulingSlug:"missing-profile"});
  const app=express();app.use(router);const server=app.listen(0,"127.0.0.1");t.after(()=>server.close());
  await new Promise(resolve=>server.once("listening",resolve));
  const base="http://127.0.0.1:"+server.address().port;
  async function read(path){const response=await fetch(base+path);return {response,body:await response.json()};}
  for(const query of ["","?publicSchedulingEnabled=false","?publicSchedulingEnabled=true"]){
    const {response,body}=await read("/public/profissionais"+query);
    assert.equal(response.status,200);assert.equal(body.items.length,1);
    assert.equal(body.items[0].slug,"published-profile");
    for(const field of ["uid","photoBase64","photoMime","pixConfigured"])assert.equal(field in body.items[0],false,field);
    assert.equal(body.items[0].publicSchedulingEnabled,true);
    assert.ok(queries.at(-1).some(([key,value])=>key==="publicSchedulingEnabled"&&value===true));
  }
  const absent=await read("/public/profissionais/nonexistent-profile");
  assert.equal((await read("/therapy/profissional/publico/firebase-disabled-uid")).response.status,404);
  for(const identifier of ["disabled-profile","missing-profile","firebase-disabled-uid","firebase-active-uid"]){
    const result=await read("/public/profissionais/"+identifier);
    assert.equal(result.response.status,404);assert.deepEqual(result.body,absent.body);
  }
  const {response,body}=await read("/public/profissionais/published-profile");
  assert.equal(response.status,200);assert.equal(body.profissional.displayName,active.displayName);
  for(const field of ["uid","photoBase64","photoMime","pixConfigured"])assert.equal(field in body.profissional,false,field);
  const photoUrl=body.profissional.photoUrl;assert.ok(photoUrl);
  const image=await fetch(base+photoUrl);assert.equal(image.status,200);assert.equal(image.headers.get("content-type"),"image/png");
  const etag=image.headers.get("etag");assert.ok(etag);
  assert.equal((await fetch(base+photoUrl,{headers:{"If-None-Match":etag}})).status,304);
  active.publicSchedulingEnabled=false;
  assert.equal((await read("/therapy/profissional/publico/firebase-active-uid")).response.status,404);
  assert.equal((await fetch(base+photoUrl,{headers:{"If-None-Match":etag}})).status,404,"revocation is checked before returning a cached photo");
  assert.equal((await read("/public/profissionais/published-profile")).response.status,404);
  assert.equal((await read("/public/profissionais")).body.items.length,0);
});
