"use strict";
const crypto = require("node:crypto");
const {encryptJson,decryptJson}=require("./clinical-encryption");
const FIELDS=["anxiety","energy","sleep"];
function normalize(input){
  if(!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).some(k=>!FIELDS.includes(k)))throw Object.assign(Error("METRICAS_INVALIDAS"),{status:400});
  const result={};
  for(const key of FIELDS){const value=input[key];if(value!==undefined && value!==null && (!Number.isInteger(value)||value<0||value>10))throw Object.assign(Error("METRICAS_INVALIDAS"),{status:400});result[key]=value??null;}
  return result;
}
function keyFor(uid,secret){if(!secret||secret.length<16)throw Object.assign(Error("BEM_ESTAR_INDISPONIVEL"),{status:503});return Buffer.from(crypto.hkdfSync("sha256",secret,uid,"ep:wellbeing:v1",32));}
function seal(uid,date,metrics,secret){const key=keyFor(uid,secret);try{return encryptJson({uid,date,metrics:normalize(metrics)},key);}finally{key.fill(0);}}
function open(uid,date,payload,secret){const key=keyFor(uid,secret);try{const item=decryptJson(payload,key);if(item.uid!==uid||item.date!==date)throw Error("REGISTRO_INVALIDO");return normalize(item.metrics);}finally{key.fill(0);}}
module.exports={normalize,seal,open};
