"use strict";
const express=require("express");
const wellbeing=require("../services/wellbeing");
const {sendError}=require("../utils");
module.exports=function({verifyFirebaseToken,ensureDb,getDb,secret,today,sealMoodNote,fieldValue}){
 const router=express.Router();
 if(sealMoodNote&&fieldValue)router.post("/therapy/paciente/humor",async(req,res)=>{
  res.set("Cache-Control","private, no-store");
  try{
   if(!ensureDb(res))return;
   const uid=await verifyFirebaseToken(req,res);if(!uid)return;
   const mood=Number(req.body?.mood);
   if(!Number.isInteger(mood)||mood<1||mood>5)return sendError(res,400,"MOOD_INVALIDO");
   const note=String(req.body?.note??"").trim();
   if(note.length>600)return sendError(res,400,"NOTA_MUITO_LONGA");
   const date=today(),extra={};let metrics;
   // Older clients can still submit mood alone. The complete daily flow writes
   // all three answers with mood and the encrypted note in a single batch.
   if(Object.hasOwn(req.body||{},"wellbeing")){
    metrics=wellbeing.normalize(req.body.wellbeing);
    if(Object.values(metrics).some(value=>value===null))return sendError(res,400,"BEM_ESTAR_INCOMPLETO");
    extra.wellbeing=wellbeing.seal(uid,date,metrics,secret);
    extra.wellbeingUpdatedAt=Date.now();
   }
   let encryptedNote;
   try{encryptedNote=note?sealMoodNote(uid,note):null;}
   catch{return sendError(res,503,"NOTA_INDISPONIVEL");}
   const db=getDb(),ref=db.collection("therapy_humor").doc(`${uid}_${date}`),history=db.collection("therapy_humor_history").doc();
   await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(snap.exists)throw Object.assign(Error("REGISTRO_JA_SALVO"),{status:409});
    tx.create(ref,{
     uid,date,mood,...(encryptedNote?{note:encryptedNote}:{}),...extra,
     at:fieldValue.serverTimestamp(),updatedAt:fieldValue.serverTimestamp()
    });
    tx.create(history,{uid,date,mood,type:"mood_recorded",at:fieldValue.serverTimestamp()});
   });
   return res.json({ok:true,date,mood,...(metrics?{wellbeing:metrics}:{})});
  }catch(error){sendError(res,error.status||503,error.status?error.message:"REGISTRO_INDISPONIVEL");}
 });
 router.patch("/therapy/paciente/humor/bem-estar",async(req,res)=>{
  res.set("Cache-Control","private, no-store");
  try{
   if(!ensureDb(res))return;
   const uid=await verifyFirebaseToken(req,res);if(!uid)return;
   const date=today();
   const ref=getDb().collection("therapy_humor").doc(`${uid}_${date}`);
   const snap=await ref.get();
   if(!snap.exists||snap.data().uid!==uid||snap.data().date!==date)return sendError(res,409,"REGISTRE_HUMOR_HOJE");
   return sendError(res,409,"REGISTRO_JA_SALVO");
  }catch(error){sendError(res,error.status||503,error.status?error.message:"BEM_ESTAR_INDISPONIVEL");}
 });return router;
};
