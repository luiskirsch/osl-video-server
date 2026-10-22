"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsAttention, counts, QUEUES } = require("../services/admin-notifications");
const support = require("../services/workplace-support");
const express = require("express");
const { once } = require("node:events");
test("admin notification counts deny anonymous users and never expose private payloads", async t => {
  let reads=0;
  const db={collection(){reads++;return {where(){return {count:()=>({get:async()=>({data:()=>({count:0})})}),limit:()=>({get:async()=>({docs:[]})})};}};}};
  const app=express();
  app.use(require("../routes/admin-notifications")({ensureDb:()=>true,getDb:()=>db,secret:"synthetic-test-secret-32-chars",
    verifyAdminTherapy:async(req,res)=>{if(req.get("authorization")==="Bearer admin-test")return {uid:"admin-test"};res.status(401).json({ok:false});return null;}}));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url=`http://127.0.0.1:${server.address().port}/therapy/admin/notifications/counts`;
  const denied=await fetch(url);assert.equal(denied.status,401);assert.equal(reads,0);
  const allowed=await fetch(url,{headers:{Authorization:"Bearer admin-test"}});
  assert.match(allowed.headers.get("cache-control"),/private, no-store/);
  const data=await allowed.json();assert.equal(data.ok,true);assert.equal(data.counts.apoio.count,0);assert.ok(!("items" in data));
});
test("support alerts remain until a response, return on employee reply, and stop while waiting", () => {
  assert.equal(needsAttention({ status:"open" }), true);
  assert.equal(needsAttention({ status:"in_progress", events:[{type:"update",actor:"care"}] }), true);
  const item = { status:"in_progress", firstResponseAt:1, events:[{type:"message",actor:"care"}] };
  assert.equal(needsAttention(item), false);
  item.events.push({type:"message",actor:"employee"}); assert.equal(needsAttention(item), true);
  for (const status of ["waiting_employee","resolved","closed","cancelled"]) assert.equal(needsAttention({...item,status}), false);
});
test("notification feed contains only counts, isolates care, and reports each failed source", async () => {
  const calls = [];
  const db = { collection(name) { return {where(field, op, value) {
    calls.push({name,field,op,value});
    return {count:()=>({get:async()=>{if(name === "therapy_message_reports") throw Error("private failure");return {data:()=>({count:3})};}}),
      limit:()=>({get:async()=>({docs:[]})})};
  }}; }};
  const result = await counts(db, "synthetic-secret-32-chars-for-tests");
  assert.equal(result.apoio.count,0); assert.equal(result.empresa.count,3);
  assert.equal(result.denuncias.error,true); assert.equal(Object.keys(result).length,Object.keys(QUEUES).length+1);
  assert.ok(calls.some(c=>c.name===support.COLLECTION && c.field==="recipient" && c.value==="care"));
  assert.ok(!JSON.stringify(result).includes("private failure"));
});
