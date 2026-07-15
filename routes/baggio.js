const express = require("express");
const router = express.Router();

const BAGGIO_API = () => process.env.BAGGIO_API_URL || "http://localhost:3001";

// Proxy: /baggio/api/* → BAGGIO_API_URL/api/*
router.get("/baggio/api/*", async (req, res) => {
  try {
    const apiPath = req.originalUrl.replace(/^\/baggio/, "");
    const url = `${BAGGIO_API()}${apiPath}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Dashboard
router.get("/baggio", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Baggio Gestão</title>
<style>
:root{--nv:#1A3B6E;--gd:#C4991F;--bg:#EEF1F6;--sf:#fff;--ink:#0D1B2A;--i3:#7A8EA3;--ln:rgba(13,27,42,.1);--ok:#0C7A45;--wn:#B45309;--cr:#B91C1C;--r:10px}
*{box-sizing:border-box;margin:0;padding:0}
html{height:100%;overflow:hidden}
body{height:100%;width:100%;overflow:hidden;font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--ink);display:flex}
#sb{width:212px;background:#0F2347;display:flex;flex-direction:column;flex-shrink:0}
.brand{padding:20px 18px;border-bottom:1px solid rgba(255,255,255,.07)}
.brand h1{font-size:21px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:-.01em}
.brand p{font-size:9px;color:var(--gd);letter-spacing:.2em;text-transform:uppercase;margin-top:3px}
nav{padding:10px;flex:1;display:flex;flex-direction:column;gap:2px}
.nb{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:7px;color:rgba(255,255,255,.5);font-size:13px;font-weight:500;cursor:pointer;border:none;background:none;width:100%;text-align:left;transition:all 120ms}
.nb:hover{background:rgba(255,255,255,.06);color:rgba(255,255,255,.85)}
.nb.on{background:rgba(255,255,255,.1);color:#fff;box-shadow:inset 3px 0 0 var(--gd)}
.bx{margin-left:auto;background:var(--cr);color:#fff;font-size:9px;font-weight:700;padding:1px 6px;border-radius:99px}
#foot{padding:12px 16px;border-top:1px solid rgba(255,255,255,.07);font-size:10px;color:rgba(255,255,255,.3)}
#foot strong{display:block;color:rgba(255,255,255,.5);margin-bottom:3px;font-size:11px}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ok);margin-right:4px;vertical-align:middle}
.dot.off{background:var(--cr)}
#main{flex:1;min-width:0;overflow-y:auto;padding:24px 28px}
.view{display:none}.view.on{display:block;width:100%}
.tb{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:12px;flex-wrap:wrap}
.tb h2{font-size:19px;font-weight:700}.tb small{font-size:12px;color:var(--i3);display:block;margin-top:1px}
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.sc{background:var(--sf);border-radius:var(--r);padding:16px 18px;border:1px solid var(--ln);box-shadow:0 1px 3px rgba(13,27,42,.05),0 4px 12px rgba(13,27,42,.06)}
.sc label{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--i3);font-weight:600;display:block;margin-bottom:8px}
.sc .v{font-size:24px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1}
.sc .v.ok{color:var(--ok)}.sc .v.cr{color:var(--cr)}
.sc small{font-size:11px;color:var(--i3);margin-top:4px;display:block}
.card{background:var(--sf);border-radius:var(--r);border:1px solid var(--ln);box-shadow:0 1px 3px rgba(13,27,42,.05),0 4px 12px rgba(13,27,42,.06);overflow:hidden;margin-bottom:14px}
.ch{padding:12px 18px;border-bottom:1px solid var(--ln);display:flex;align-items:center;justify-content:space-between}
.ch span{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--i3)}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:9px 14px;text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--i3);font-weight:600;border-bottom:1px solid var(--ln);white-space:nowrap}
td{padding:10px 14px;border-bottom:1px solid var(--ln);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--bg)}
.nr{text-align:right;font-weight:600}
.bk{display:inline-block;padding:2px 8px;border-radius:99px;font-size:10.5px;font-weight:700}
.bk.ok{background:#E6F4EE;color:var(--ok)}.bk.wn{background:#FEF3C7;color:var(--wn)}.bk.cr{background:#FEE2E2;color:var(--cr)}
.cr2{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:12px}
.ck{padding:4px 13px;border-radius:99px;border:1.5px solid var(--ln);font-size:11.5px;font-weight:600;color:#3D5166;background:var(--sf);cursor:pointer;transition:all 120ms}
.ck:hover,.ck.on{background:var(--nv);border-color:var(--nv);color:#fff}
.sr{position:relative}.sr input{padding:8px 12px 8px 34px;border:1.5px solid var(--ln);border-radius:var(--r);background:var(--sf);font-size:13px;color:var(--ink);outline:none;max-width:280px}
.sr input:focus{border-color:var(--nv)}.sr svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--i3)}
.ar{display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid var(--ln)}
.ar:last-child{border-bottom:none}.ar:hover{background:var(--bg)}
.ast{width:4px;height:34px;border-radius:2px;flex-shrink:0}
.ar.cr .ast{background:var(--cr)}.ar.wn .ast{background:var(--wn)}
.an{flex:1}.an strong{font-size:13px;display:block}.an small{font-size:11px;color:var(--i3)}
.aq{text-align:right;font-size:11px;color:var(--i3);font-variant-numeric:tabular-nums}
.aq strong{display:block;font-size:15px;font-weight:700}
.ar.cr .aq strong{color:var(--cr)}.ar.wn .aq strong{color:var(--wn)}
.cbr{display:flex;align-items:center;gap:10px;padding:9px 18px;border-bottom:1px solid var(--ln)}
.cbr:last-child{border-bottom:none}
.cbl{font-size:12px;width:90px;flex-shrink:0;color:#3D5166}
.cbt{flex:1;height:6px;border-radius:3px;background:var(--ln);overflow:hidden}
.cbf{height:100%;border-radius:3px}
.cbp{font-size:11px;font-weight:600;width:32px;text-align:right;color:#3D5166;font-variant-numeric:tabular-nums}
.slr{display:flex;align-items:center;gap:10px;padding:9px 18px;border-bottom:1px solid var(--ln);font-size:12.5px}
.slr:last-child{border-bottom:none}
.sld{width:6px;height:6px;border-radius:50%;background:var(--nv);flex-shrink:0}
.sln{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slv{font-weight:700;color:var(--ok);font-variant-numeric:tabular-nums}
.slt{font-size:11px;color:var(--i3);white-space:nowrap}
.pb{height:5px;border-radius:3px;background:var(--ln);width:70px;overflow:hidden}
.pbf{height:100%;border-radius:3px;background:var(--cr)}.pbf.w{background:var(--wn)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;border:none;transition:all 130ms}
.btng{border:1.5px solid var(--ln);color:#3D5166;background:transparent}.btng:hover{border-color:var(--i3);color:var(--ink)}
.btnp{background:var(--nv);color:#fff}.btnp:hover{background:#223F72}
.g2{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:14px}
@media(prefers-color-scheme:dark){:root{--bg:#0D1520;--sf:#13202F;--ink:#E8EFF6;--i3:#4E6880;--ln:rgba(232,239,246,.08)}}
.overlay{position:fixed;inset:0;background:rgba(13,27,42,.55);z-index:100;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity 160ms}
.overlay.on{opacity:1;pointer-events:auto}
.mbox{background:var(--sf);border-radius:14px;width:min(500px,92vw);box-shadow:0 12px 48px rgba(13,27,42,.25);padding:24px;max-height:90vh;overflow-y:auto}
.mh{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px;gap:12px}
.mh h3{font-size:14px;font-weight:700;line-height:1.3}
.mh small{font-size:11px;color:var(--i3);margin-top:3px;display:block}
.mx{border:none;background:none;cursor:pointer;color:var(--i3);font-size:18px;padding:2px 4px;line-height:1;flex-shrink:0}
.mx:hover{color:var(--ink)}
.mf{display:flex;flex-direction:column;gap:9px}
.mrow{display:flex;gap:10px;align-items:baseline}
.mk{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--i3);font-weight:600;width:74px;flex-shrink:0}
.mv{font-size:13px;flex:1}
.msep{border:none;border-top:1px solid var(--ln);margin:6px 0}
.mwarn{padding:10px 14px;background:#FEF3C7;border-radius:8px;font-size:12px;color:var(--wn);line-height:1.5}
</style>
</head>
<body>
<div id="sb">
  <div class="brand"><h1>Baggio</h1><p>Gestão de Estoque</p></div>
  <nav>
    <button class="nb on" onclick="nav('dash')" id="n-dash">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>Dashboard
    </button>
    <button class="nb" onclick="nav('estoque')" id="n-estoque">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>Estoque
    </button>
    <button class="nb" onclick="nav('vendas')" id="n-vendas">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Vendas Hoje
    </button>
    <button class="nb" onclick="nav('compras')" id="n-compras">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>Compras
      <span class="bx" id="abx" style="display:none">0</span>
    </button>
  </nav>
  <div id="foot"><strong>Supermercados Baggio</strong>
    <span class="dot" id="cdot"></span><span id="upd">Conectando…</span>
  </div>
</div>
<main id="main">
  <div class="view on" id="v-dash">
    <div class="tb"><div><h2 id="greet">Carregando…</h2><small id="ddate"></small></div>
      <button class="btn btng" onclick="load()">&#8635; Atualizar</button></div>
    <div class="sg" id="sg"></div>
    <div class="g2">
      <div class="card"><div class="ch"><span>Alertas de ruptura</span><button class="btn btng" style="padding:4px 10px;font-size:11px" onclick="nav('compras')">Ver todos</button></div><div id="dalerts"></div></div>
      <div class="card"><div class="ch"><span>Saúde por grupo</span></div><div id="dcats"></div></div>
    </div>
    <div class="card"><div class="ch"><span>Últimas vendas do dia</span></div><div id="dsales"></div></div>
  </div>
  <div class="view" id="v-estoque">
    <div class="tb"><div><h2>Estoque</h2><small id="ecount"></small></div>
      <div class="sr"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input type="search" placeholder="Buscar produto…" id="esrch" oninput="renderE()"></div></div>
    <div class="cr2" id="echips"></div>
    <div class="card"><div class="tw"><table><thead><tr><th>Produto</th><th>Grupo</th><th>Unid.</th><th style="text-align:right">Estoque atual</th><th style="text-align:right">Mínimo</th><th>Status</th></tr></thead><tbody id="etb"></tbody></table></div></div>
  </div>
  <div class="view" id="v-vendas">
    <div class="tb"><div><h2>Vendas de Hoje</h2><small id="vsub"></small></div>
      <div class="sr"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input type="search" placeholder="Buscar produto…" id="vsrch" oninput="renderV()"></div></div>
    <div class="card"><div class="tw"><table><thead><tr><th>Hora</th><th>Produto</th><th>Unid.</th><th style="text-align:right">Qtd.</th><th style="text-align:right">Valor</th></tr></thead><tbody id="vtb"></tbody></table></div></div>
  </div>
  <div class="view" id="v-compras">
    <div class="tb"><div><h2>Lista de Compras</h2><small id="csub"></small></div>
      <button class="btn btnp" onclick="printC()">&#9998; Imprimir lista</button></div>
    <div class="cr2" id="achips"></div>
    <div class="cr2" id="agchips"></div>
    <div class="card"><div class="tw"><table><thead><tr><th>Produto</th><th>Grupo</th><th style="text-align:right">Atual</th><th style="text-align:right">Mínimo</th><th style="text-align:right">Comprar</th><th>Urgência</th><th>Nível</th></tr></thead><tbody id="ctb"></tbody></table></div></div>
  </div>
</main>
<div class="overlay" id="prodModal" onclick="if(event.target===this)closeModal()">
  <div class="mbox">
    <div class="mh">
      <div><h3 id="mProd"></h3><small id="mGrp"></small></div>
      <button class="mx" onclick="closeModal()">&#10005;</button>
    </div>
    <div class="mf" id="mBody"></div>
  </div>
</div>
<script>
const API='/baggio';
let D={stats:null,alertas:[],estoque:[],vendas:[]},cat='Todos',curV='dash',_CATS=[],alertMode='all',alertCat='Todos';
var AMODES=['all','zerado','minimo'],_ACATS=[],_CPRODS=[];
function selectCat(i){cat=_CATS[i];renderE();}
const M=v=>'R$ '+(+v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const H=h=>h?String(h).substring(0,5):'--';
function st(p){if(p.pr_estoqueminimo>0){if(p.pr_estoqueatual<=0)return'cr';const r=p.pr_estoqueatual/p.pr_estoqueminimo;return r<=0.5?'cr':r<=1?'wn':'ok';}return p.pr_estoqueatual<=0?'cr':'ok';}
function bk(s){return '<span class="bk '+s+'">'+(s==='cr'?'CRÍTICO':s==='wn'?'ATENÇÃO':'OK')+'</span>';}
function computeAlertas(estoque){return estoque.filter(function(p){if(alertMode==='zerado')return p.pr_estoqueatual<=0;if(alertMode==='minimo')return p.pr_estoqueminimo>0&&p.pr_estoqueatual<p.pr_estoqueminimo;return p.pr_estoqueatual<=0||(p.pr_estoqueminimo>0&&p.pr_estoqueatual<p.pr_estoqueminimo);});}
function setAlertMode(i){alertMode=AMODES[i];alertCat='Todos';D.alertas=computeAlertas(D.estoque);updateBadge();renderCur();}
function setAlertCat(i){alertCat=_ACATS[i];renderC();}
function closeModal(){document.getElementById('prodModal').classList.remove('on');}
function openProdIdx(i){var p=_CPRODS[i];openProd(p.pr_codebar,p.pr_descricao,p.pr_grupo||'',p);}
async function openProd(cod,nome,grp,p){
  document.getElementById('mProd').textContent=nome;
  document.getElementById('mGrp').textContent=grp?'Gr.'+grp:'';
  document.getElementById('mBody').innerHTML='<div style="text-align:center;padding:16px;color:var(--i3);font-size:13px">Buscando fornecedor…</div>';
  document.getElementById('prodModal').classList.add('on');
  var sug=Math.max(0,(p.pr_estoquemaximo||p.pr_estoqueminimo*3||10)-(+p.pr_estoqueatual||0));
  try{
    var r=await fetch(API+'/api/produto/'+encodeURIComponent(cod));
    var d=await r.json();
    if(!d||d.error)throw new Error(d&&d.error||'resposta vazia');
    var sug2=Math.max(0,(d.pr_estoquemaximo||d.pr_estoqueminimo*3||10)-(+d.pr_estoqueatual||0));
    var nomeFor=d.fo_nome||d.fr_fantasia||d.pr_nomefornecedor||'';
    var tel=d.fr_telefone&&d.fr_telefone.replace(/[^\d]/g,'').length>4?d.fr_telefone:'';
    var tel2=d.fr_telefone2&&d.fr_telefone2.replace(/[^\d]/g,'').length>4?d.fr_telefone2:'';
    var cel=d.fr_celular2&&d.fr_celular2.replace(/[^\d]/g,'').length>4?d.fr_celular2:'';
    var cfone=d.fr_contato_fone&&d.fr_contato_fone.replace(/[^\d]/g,'').length>4?d.fr_contato_fone:'';
    var ccel=d.fr_contato_celular&&d.fr_contato_celular.replace(/[^\d]/g,'').length>4?d.fr_contato_celular:'';
    var email=d.fr_email&&d.fr_email.includes('@')?d.fr_email:'';
    var local=d.fr_cidade?d.fr_cidade+(d.fr_estado?' — '+d.fr_estado:''):'';
    var temFor=nomeFor||tel||email;
    document.getElementById('mBody').innerHTML=
      '<div class="mrow"><span class="mk">Estoque</span><span class="mv"><b style="color:var(--cr)">'+(+d.pr_estoqueatual||0).toLocaleString('pt-BR',{maximumFractionDigits:3})+'</b> '+d.pr_unidade+' · mín '+(d.pr_estoqueminimo||0)+'</span></div>'+
      '<div class="mrow"><span class="mk">Comprar</span><span class="mv" style="font-weight:700;color:var(--nv)">'+sug2.toFixed(0)+' '+d.pr_unidade+'</span></div>'+
      (d.pr_precovenda?'<div class="mrow"><span class="mk">Preço venda</span><span class="mv">'+M(d.pr_precovenda)+'</span></div>':'')+
      ((d.pr_vda7||d.pr_vda30)?'<div class="mrow"><span class="mk">Giro</span><span class="mv" style="color:var(--i3)">'+(d.pr_vda7?d.pr_vda7.toFixed(1)+' un/7d':'')+' '+(d.pr_vda30?' · '+d.pr_vda30.toFixed(1)+' un/30d':'')+'</span></div>':'')+
      '<hr class="msep">'+
      (nomeFor?'<div class="mrow"><span class="mk">Fornecedor</span><span class="mv" style="font-weight:600">'+nomeFor+'</span></div>':'')+
      (local?'<div class="mrow"><span class="mk">Cidade</span><span class="mv" style="color:var(--i3)">'+local+'</span></div>':'')+
      (d.fr_contato?'<div class="mrow"><span class="mk">Contato</span><span class="mv">'+d.fr_contato+'</span></div>':'')+
      (tel?'<div class="mrow"><span class="mk">Telefone</span><span class="mv"><a href="tel:'+tel+'" style="color:var(--nv);text-decoration:none;font-weight:600">'+tel+'</a>'+(tel2?' · <a href="tel:'+tel2+'" style="color:var(--nv);text-decoration:none">'+tel2+'</a>':'')+'</span></div>':'')+
      (cel||cfone||ccel?'<div class="mrow"><span class="mk">Celular</span><span class="mv"><a href="tel:'+(cel||cfone||ccel)+'" style="color:var(--nv);text-decoration:none;font-weight:600">'+(cel||cfone||ccel)+'</a></span></div>':'')+
      (email?'<div class="mrow"><span class="mk">E-mail</span><span class="mv"><a href="mailto:'+email+'" style="color:var(--nv);text-decoration:none">'+email+'</a></span></div>':'')+
      (!temFor?'<div style="padding:10px;text-align:center;color:var(--i3);font-size:12px">Fornecedor não cadastrado</div>':'');
  }catch(e){
    document.getElementById('mBody').innerHTML=
      '<div class="mrow"><span class="mk">Estoque</span><span class="mv"><b style="color:var(--cr)">'+(+p.pr_estoqueatual||0)+'</b> '+p.pr_unidade+'</span></div>'+
      '<div class="mrow"><span class="mk">Comprar</span><span class="mv" style="font-weight:700;color:var(--nv)">'+sug.toFixed(0)+' '+p.pr_unidade+'</span></div>'+
      '<hr class="msep"><div class="mwarn"><b>Erro:</b> '+e.message+'</div>';
  }
}
async function load(){
  try{
    const[s,e,v]=await Promise.allSettled([
      fetch(API+'/api/stats').then(r=>r.json()),
      fetch(API+'/api/estoque').then(r=>r.json()),
      fetch(API+'/api/vendas-hoje').then(r=>r.json()),
    ]);
    if(s.status==='fulfilled'&&!s.value.error)D.stats=s.value;
    if(e.status==='fulfilled'&&Array.isArray(e.value)){D.estoque=e.value;D.alertas=computeAlertas(e.value);}
    if(v.status==='fulfilled'&&Array.isArray(v.value))D.vendas=v.value;
    document.getElementById('cdot').className='dot';
    document.getElementById('upd').textContent='Atualizado '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  }catch(err){document.getElementById('cdot').className='dot off';document.getElementById('upd').textContent='Sem conexão';}
  updateBadge();renderCur();
}
function updateBadge(){const b=document.getElementById('abx'),n=D.alertas.length;b.textContent=n;b.style.display=n?'inline':'none';}
function nav(v){document.querySelectorAll('.view').forEach(x=>x.classList.remove('on'));document.querySelectorAll('.nb').forEach(x=>x.classList.remove('on'));document.getElementById('v-'+v).classList.add('on');document.getElementById('n-'+v).classList.add('on');curV=v;renderCur();}
function renderCur(){if(curV==='dash')renderD();if(curV==='estoque')renderE();if(curV==='vendas')renderV();if(curV==='compras')renderC();}
function renderD(){
  const now=new Date(),h=now.getHours();
  document.getElementById('greet').textContent=(h<12?'Bom dia':h<18?'Boa tarde':'Boa noite')+', Baggio';
  document.getElementById('ddate').textContent=now.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  const hj=D.stats&&D.stats.hoje||{};
  document.getElementById('sg').innerHTML='<div class="sc"><label>Faturamento hoje</label><div class="v ok" style="font-size:18px">'+M(hj.total)+'</div><small>valor total em vendas</small></div>'+
    '<div class="sc"><label>Cupons emitidos</label><div class="v">'+(+hj.cupons||0).toLocaleString('pt-BR')+'</div><small>transações no caixa</small></div>'+
    '<div class="sc"><label>Unidades vendidas</label><div class="v">'+(+hj.unidades||0).toLocaleString('pt-BR',{maximumFractionDigits:0})+'</div><small>itens saídos hoje</small></div>'+
    '<div class="sc"><label>Alertas de ruptura</label><div class="v '+(D.alertas.length?'cr':'ok')+'">'+D.alertas.length+'</div><small>abaixo do mínimo</small></div>';
  document.getElementById('dalerts').innerHTML=D.alertas.slice(0,5).map(function(p){var s=st(p);return'<div class="ar '+s+'"><div class="ast"></div><div class="an"><strong>'+p.pr_descricao+'</strong><small>Grupo '+(p.pr_grupo||'—')+' · mín '+p.pr_estoqueminimo+' '+p.pr_unidade+'</small></div><div class="aq"><strong>'+(+p.pr_estoqueatual||0).toLocaleString('pt-BR',{maximumFractionDigits:2})+'</strong>'+p.pr_unidade+'</div></div>';}).join('')||'<div style="padding:20px;text-align:center;color:var(--ok);font-size:13px;font-weight:600">✓ Sem alertas</div>';
  var grps=[...new Set(D.estoque.map(function(p){return String(p.pr_grupo||'');}).filter(Boolean))].slice(0,7);
  document.getElementById('dcats').innerHTML=grps.map(function(g){var ps=D.estoque.filter(function(p){return String(p.pr_grupo)===g;});var pct=Math.round(ps.filter(function(p){return st(p)==='ok';}).length/ps.length*100);var col=pct>80?'var(--ok)':pct>50?'var(--wn)':'var(--cr)';return'<div class="cbr"><div class="cbl">Gr.'+g+'</div><div class="cbt"><div class="cbf" style="width:'+pct+'%;background:'+col+'"></div></div><div class="cbp">'+pct+'%</div></div>';}).join('')||'<div style="padding:16px;color:var(--i3);font-size:12px;text-align:center">Sem dados</div>';
  document.getElementById('dsales').innerHTML=D.vendas.slice(0,8).map(function(v){return'<div class="slr"><div class="sld"></div><div class="sln">'+(v.pr_descricao||v.mg_codebar||'—')+'</div><div class="slv">'+M(v.mg_valor)+'</div><div class="slt">'+H(v.mg_hora)+'</div></div>';}).join('')||'<div style="padding:20px;text-align:center;color:var(--i3)">Sem vendas hoje</div>';
}
function cats(){return['Todos',...new Set(D.estoque.map(function(p){return String(p.pr_grupo||'');}).filter(Boolean))];}
function renderE(){
  var q=(document.getElementById('esrch').value||'').toLowerCase();
  _CATS=cats();
  var ps=D.estoque.filter(function(p){return(cat==='Todos'||String(p.pr_grupo)===cat)&&(!q||(p.pr_descricao||'').toLowerCase().includes(q));});
  document.getElementById('echips').innerHTML=_CATS.map(function(c,i){return'<button class="ck'+(c===cat?' on':'')+'" onclick="selectCat('+i+')">'+(c==='Todos'?'Todos':'Gr.'+c)+'</button>';}).join('');
  document.getElementById('ecount').textContent=ps.length+' produto'+(ps.length!==1?'s':'');
  document.getElementById('etb').innerHTML=ps.map(function(p){var s=st(p);var col=s==='cr'?'var(--cr)':s==='wn'?'var(--wn)':'var(--ink)';return'<tr><td style="font-weight:600">'+p.pr_descricao+'</td><td style="color:var(--i3)">Gr.'+(p.pr_grupo||'—')+'</td><td style="color:var(--i3)">'+(p.pr_unidade||'—')+'</td><td class="nr" style="color:'+col+'">'+(+p.pr_estoqueatual||0).toLocaleString('pt-BR',{maximumFractionDigits:3})+'</td><td class="nr" style="color:var(--i3)">'+(p.pr_estoqueminimo>0?p.pr_estoqueminimo:'—')+'</td><td>'+(p.pr_estoqueminimo>0?bk(s):'<span style="color:var(--i3);font-size:11px">—</span>')+'</td></tr>';}).join('')||'<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--i3)">Nenhum produto</td></tr>';
}
function renderV(){
  var q=(document.getElementById('vsrch').value||'').toLowerCase();
  var vs=D.vendas.filter(function(v){return!q||(v.pr_descricao||v.mg_codebar||'').toLowerCase().includes(q);});
  var hj=D.stats&&D.stats.hoje||{};
  document.getElementById('vsub').textContent=vs.length+' itens · '+M(hj.total)+' em '+(+hj.cupons||0).toLocaleString('pt-BR')+' cupons';
  document.getElementById('vtb').innerHTML=vs.map(function(v){return'<tr><td style="font-weight:600;color:var(--i3)">'+H(v.mg_hora)+'</td><td>'+(v.pr_descricao||v.mg_codebar||'—')+'</td><td style="color:var(--i3)">'+(v.pr_unidade||'—')+'</td><td class="nr">'+(+v.mg_quantidade||0).toLocaleString('pt-BR',{maximumFractionDigits:3})+'</td><td class="nr" style="color:var(--ok)">'+M(v.mg_valor)+'</td></tr>';}).join('')||'<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--i3)">Sem vendas hoje</td></tr>';
}
function renderC(){
  var _modes=[['all','Todos'],['zerado','Zerado/Negativo'],['minimo','Abaixo do mínimo']];
  document.getElementById('achips').innerHTML=_modes.map(function(m,i){return'<button class="ck'+(alertMode===m[0]?' on':'')+'" onclick="setAlertMode('+i+')">'+ m[1]+'</button>';}).join('');
  _ACATS=['Todos',...new Set(D.alertas.map(function(p){return String(p.pr_grupo||'');}).filter(Boolean))];
  document.getElementById('agchips').innerHTML=_ACATS.map(function(g,i){return'<button class="ck'+(alertCat===g?' on':'')+'" onclick="setAlertCat('+i+')">'+(g==='Todos'?'Todos':'Gr.'+g)+'</button>';}).join('');
  var ps=alertCat==='Todos'?D.alertas:D.alertas.filter(function(p){return String(p.pr_grupo||'')===alertCat;});
  var _lbl=alertMode==='zerado'?'zerados/negativos':alertMode==='minimo'?'abaixo do mínimo':'em alerta';
  document.getElementById('csub').textContent=ps.length+' produto'+(ps.length!==1?'s':'')+' '+_lbl;
  _CPRODS=ps;
  document.getElementById('ctb').innerHTML=ps.map(function(p,i){var s=st(p);var pct=p.pr_estoqueminimo>0?Math.min(100,Math.max(0,Math.round(p.pr_estoqueatual/p.pr_estoqueminimo*100))):0;var sug=Math.max(0,(p.pr_estoquemaximo||p.pr_estoqueminimo*3)-p.pr_estoqueatual);return'<tr style="cursor:pointer" onclick="openProdIdx('+i+')"><td style="font-weight:600">'+p.pr_descricao+'</td><td style="color:var(--i3)">Gr.'+(p.pr_grupo||'—')+'</td><td class="nr" style="color:'+(s==='cr'?'var(--cr)':'var(--wn)')+'">'+(+p.pr_estoqueatual||0).toLocaleString('pt-BR',{maximumFractionDigits:3})+'</td><td class="nr" style="color:var(--i3)">'+p.pr_estoqueminimo+'</td><td class="nr" style="font-weight:700;color:var(--nv)">'+sug.toFixed(0)+' '+p.pr_unidade+'</td><td>'+bk(s)+'</td><td><div style="display:flex;align-items:center;gap:6px"><div class="pb"><div class="pbf'+(s==='wn'?' w':'')+'" style="width:'+pct+'%"></div></div><span style="font-size:11px;color:var(--i3)">'+pct+'%</span></div></td></tr>';}).join('')||'<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--ok);font-weight:600">✓ Sem alertas</td></tr>';
}
function printC(){
  var html='<html><head><title>Lista Compras Baggio</title><style>body{font-family:system-ui;padding:20px;color:#111}h1{font-size:16px;margin-bottom:4px}p{color:#666;font-size:12px;margin-bottom:16px}table{width:100%;border-collapse:collapse}th{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#888;padding:7px 10px;border-bottom:2px solid #eee;text-align:left}td{padding:8px 10px;border-bottom:1px solid #eee;font-size:12px}.c{padding:2px 7px;border-radius:99px;font-size:10px;font-weight:700}.cr{background:#fee2e2;color:#b91c1c}.wn{background:#fef3c7;color:#b45309}</style></head><body><h1>Lista de Compras — Supermercados Baggio</h1><p>'+new Date().toLocaleString('pt-BR')+' · '+D.alertas.length+' itens</p><table><thead><tr><th>Produto</th><th>Gr.</th><th>Atual</th><th>Mínimo</th><th>Comprar</th><th>Urgência</th></tr></thead><tbody>'+
  D.alertas.map(function(p){return'<tr><td style="font-weight:600">'+p.pr_descricao+'</td><td>'+(p.pr_grupo||'—')+'</td><td>'+(+p.pr_estoqueatual||0).toLocaleString('pt-BR',{maximumFractionDigits:3})+' '+p.pr_unidade+'</td><td>'+p.pr_estoqueminimo+' '+p.pr_unidade+'</td><td style="font-weight:700">'+Math.max(0,(p.pr_estoquemaximo||p.pr_estoqueminimo*3)-p.pr_estoqueatual).toFixed(0)+' '+p.pr_unidade+'</td><td><span class="c '+st(p)+'">'+(st(p)==='cr'?'CRÍTICO':'ATENÇÃO')+'</span></td></tr>';}).join('')+
  '</tbody></table></body></html>';
  var w=window.open('','_blank');w.document.write(html);w.document.close();w.print();
}
load();
setInterval(load,60000);
</script>
</body></html>`;

module.exports = router;
