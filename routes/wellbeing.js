"use strict";
const express=require("express");
const wellbeing=require("../services/wellbeing");
const {sendError}=require("../utils");
module.exports=function({verifyFirebaseToken,ensureDb,getDb,secret,today}){
 const router=express.Router();
 router.patch("/therapy/paciente/humor/bem-estar",async(req,res)=>{
  res.set("Cache-Control","private, no-store");
  try{
   if(!ensureDb(res))return;
   const uid=await verifyFirebaseToken(req,res);if(!uid)return;
   const metrics=wellbeing.normalize(req.body);const date=today();
   const ref=getDb().collection("therapy_humor").doc(`${uid}_${date}`);
   const payload=wellbeing.seal(uid,date,metrics,secret);
   await getDb().runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(!snap.exists||snap.data().uid!==uid||snap.data().date!==date)throw Object.assign(Error("REGISTRE_HUMOR_HOJE"),{status:409});
    tx.update(ref,{wellbeing:payload,wellbeingUpdatedAt:Date.now()});
   });
   res.json({ok:true,date,metrics});
  }catch(error){sendError(res,error.status||503,error.status?error.message:"BEM_ESTAR_INDISPONIVEL");}
 });return router;
};
