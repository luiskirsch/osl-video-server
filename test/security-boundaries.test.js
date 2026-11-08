"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),express=require("express");
const {healthToken,canReadHealth}=require("../services/deployment-health");
const {signPayload}=require("../services/auth");
const {headersFor}=require("../services/cors-policy");
const {assertFirebaseIsolation}=require("../services/firebase-isolation");
const {configureRouteBuckets,routeBucket,requestIdentity,globalLimiter}=require("../services/rateLimit");

test("health credentials are expiring and scoped, not reusable admin credentials",()=>{
 const secret="synthetic-deployment-health-secret-1234567890",req=token=>({headers:{authorization:"Bearer "+token}});
 assert.equal(canReadHealth(req(healthToken(secret)),secret),true);
 for(const payload of [{token_type:"panel_session",exp:Date.now()+60000},{token_type:"deployment_health",scope:"admin",exp:Date.now()+60000},{token_type:"deployment_health",scope:"health:read",exp:Date.now()-1}])assert.equal(canReadHealth(req(signPayload(payload,secret)),secret),false);
});
test("public health and root contain no deployment metadata; internal health denies anonymous callers",async t=>{
 const app=express();app.use(require("../routes/health"));const server=app.listen(0,"127.0.0.1");t.after(()=>server.close());
 await new Promise(resolve=>server.once("listening",resolve));const base="http://127.0.0.1:"+server.address().port;
 for(const path of ["/","/health"])assert.deepEqual(await fetch(base+path).then(r=>r.json()),{ok:true});
 assert.equal((await fetch(base+"/internal/health")).status,401);
});
test("preflight declares only the headers needed by the selected route",()=>{
 assert.deepEqual(headersFor({path:"/public/leads/instituicao"}),["Content-Type","X-Locale"]);
 assert.deepEqual(headersFor({path:"/public/profissionais"}),["Authorization","Content-Type","X-Locale"]);
 assert.ok(headersFor({path:"/therapy/sessao/example/resumo-ia"}).includes("X-AI-Result-Key"));
 assert.ok(headersFor({path:"/therapy/nfse/emitir"}).includes("X-Nfse-Token"));
 for(const path of ["/public/leads","/therapy/profissional/me","/internal/health"])assert.ok(!headersFor({path}).includes("X-Admin-Secret"));
});
test("route counters do not share limits; dynamic identifiers share the matched route bucket",async t=>{
 const app=express();app.use(globalLimiter);app.get("/public/leads",(_q,r)=>r.json({ok:true}));app.get("/health",(_q,r)=>r.json({ok:true}));app.get("/things/:id",(_q,r)=>r.json({ok:true}));configureRouteBuckets(app);
 assert.equal(routeBucket({app,path:"/things/first",method:"GET"}),routeBucket({app,path:"/things/second",method:"GET"}));
 const server=app.listen(0,"127.0.0.1");t.after(()=>server.close());await new Promise(resolve=>server.once("listening",resolve));const base="http://127.0.0.1:"+server.address().port;
 const a=await fetch(base+"/public/leads"),h=await fetch(base+"/health"),b=await fetch(base+"/public/leads");
 assert.equal(Number(a.headers.get("ratelimit-remaining"))-Number(b.headers.get("ratelimit-remaining")),1);
 assert.equal(Number(h.headers.get("ratelimit-remaining")),299);
});
test("unverified bearer strings cannot mint rate-limit identities behind a school NAT",async t=>{
 const admin=require("firebase-admin");t.mock.method(admin,"auth",()=>({verifyIdToken:async(token,revoked)=>{assert.equal(revoked,true);if(token==="valid-a")return{uid:"a"};if(token==="valid-b")return{uid:"b"};throw Error("invalid");}}));
 const request=token=>({ip:"203.0.113.1",headers:{authorization:"Bearer "+token}});
 assert.equal(await requestIdentity(request("forged-a")),await requestIdentity(request("forged-b")));
 assert.notEqual(await requestIdentity(request("valid-a")),await requestIdentity(request("valid-b")));
});
test("clinical service rejects the wrong Firebase project or activation of game routes",()=>{
 assert.throws(()=>assertFirebaseIsolation("wrong",{FIREBASE_EXPECTED_PROJECT_ID:"clinical"}),/MISMATCH/);
 assert.throws(()=>assertFirebaseIsolation("osextolugar-game",{SERVICE_PRODUCT:"preludio",GAME_ENABLED:"true"}),/CANNOT_ENABLE_GAME/);
 assert.throws(()=>assertFirebaseIsolation("osextolugar-jogo",{SERVICE_PRODUCT:"preludio"}),/NOT_ALLOWED|CANNOT_USE_GAME_PROJECT/);
 assert.throws(()=>assertFirebaseIsolation("osextolugar-game",{SERVICE_PRODUCT:"preludio",APP_ENV:"staging",FIREBASE_EXPECTED_PROJECT_ID:"osextolugar-game"}),/NOT_ALLOWED/);
 assert.doesNotThrow(()=>assertFirebaseIsolation("espaco-preludio-clinico",{FIREBASE_EXPECTED_PROJECT_ID:"espaco-preludio-clinico",SERVICE_PRODUCT:"preludio"}));
});
