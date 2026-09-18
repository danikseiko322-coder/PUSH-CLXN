// PUSH CLXN backend
// Node.js 18+
// DonationAlerts OAuth token stays on the server.
//
// Setup:
//   npm install
//   copy .env.example to .env
//   put DA_ACCESS_TOKEN into .env
//   npm start
//
// The payment check matches:
//   1) exact amount in RUB
//   2) unique PUSH-... order code in donation message
//
// IMPORTANT: never put DA_ACCESS_TOKEN in index.html or send it to the browser.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(__dirname, "data.json");

app.use(express.json({limit:"6mb"}));
app.use(express.static(__dirname));

function load(){
  try {
    return JSON.parse(fs.readFileSync(DATA, "utf8"));
  } catch {
    return {orders:{}, ads:[], reviews:[], recoveryRequests:[]};
  }
}
function save(db){
  fs.writeFileSync(DATA, JSON.stringify(db, null, 2));
}

function configured(){
  return Boolean(String(process.env.DA_ACCESS_TOKEN || "").trim());
}

async function fetchDonations(){
  const token = String(process.env.DA_ACCESS_TOKEN || "").trim();
  if(!token) {
    const err = new Error("DA_ACCESS_TOKEN is not configured");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  // DonationAlerts paginates this endpoint. Read several pages so a recent
  // donation is not missed when the account has more than 30 donations.
  const all = [];
  let url = "https://www.donationalerts.com/api/v1/alerts/donations?page=1";
  const maxPages = Number(process.env.DA_MAX_PAGES || 10);

  for(let page = 1; page <= maxPages && url; page++){
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });

    if(!r.ok){
      const err = new Error(`DonationAlerts API returned HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }

    const body = await r.json();
    if(Array.isArray(body.data)) all.push(...body.data);
    url = body?.links?.next || null;
  }

  return all;
}

function normalizeMessage(value){
  return String(value || "").trim().toUpperCase();
}

function donationMatches(d, code, amount){
  return (
    Number(d.amount) === Number(amount) &&
    String(d.currency || "").toUpperCase() === "RUB" &&
    normalizeMessage(d.message).includes(normalizeMessage(code))
  );
}

app.get("/api/status", (req,res)=>{
  res.json({
    ok: true,
    paymentChecker: configured() ? "configured" : "not_configured"
  });
});

app.get("/api/check-payment", async (req,res)=>{
  const code = String(req.query.code || "").trim();
  const amount = Number(req.query.amount || 0);

  if(!/^PUSH-[A-Z0-9]+-[0-9]+$/i.test(code) || !Number.isFinite(amount) || amount <= 0){
    return res.status(400).json({paid:false, error:"invalid_order"});
  }

  const db = load();
  if(db.orders[code]?.paid){
    return res.json({paid:true});
  }

  // Record the expected amount for this code. If the browser sends a different
  // amount later, the order is not silently changed.
  if(!db.orders[code]){
    db.orders[code] = {
      amount,
      createdAt: new Date().toISOString()
    };
    save(db);
  } else if(Number(db.orders[code].amount) !== amount){
    return res.status(400).json({paid:false, error:"amount_mismatch"});
  }

  try{
    const list = await fetchDonations();
    const hit = list.find(d => donationMatches(d, code, amount));

    if(hit){
      // One DonationAlerts donation can confirm only one order.
      const alreadyUsed = Object.entries(db.orders).some(([otherCode, order]) =>
        otherCode !== code && order?.paid && String(order.donationId) === String(hit.id)
      );
      if(alreadyUsed){
        return res.json({paid:false, error:"donation_already_used"});
      }

      db.orders[code] = {
        ...db.orders[code],
        paid: true,
        donationId: hit.id,
        paidAt: hit.created_at || new Date().toISOString()
      };
      save(db);
      return res.json({paid:true});
    }

    return res.json({paid:false});
  }catch(e){
    console.error("[payment-check]", e.message);

    if(e.code === "NOT_CONFIGURED"){
      return res.status(503).json({
        paid:false,
        error:"not_configured",
        message:"DonationAlerts не подключён на сервере."
      });
    }

    if(e.status === 401 || e.status === 403){
      return res.status(503).json({
        paid:false,
        error:"invalid_token",
        message:"DonationAlerts отклонил OAuth-токен. Проверь DA_ACCESS_TOKEN и права oauth-donation-index."
      });
    }

    return res.status(503).json({
      paid:false,
      error:"api_unavailable",
      message:"DonationAlerts API временно недоступен."
    });
  }
});

app.post("/api/submit-ad",(req,res)=>{
  const {code,plan,amount,name,url,description,category} = req.body || {};
  const db = load();
  const order = db.orders[code];

  if(!order?.paid || Number(order.amount) !== Number(amount)){
    return res.status(403).json({
      ok:false,
      message:"Оплата этого заказа ещё не подтверждена."
    });
  }

  if(!name || !url || !description){
    return res.status(400).json({
      ok:false,
      message:"Заполни все поля."
    });
  }

  const ad = {
    id: "ad_" + Date.now(),
    code,
    plan,
    amount: Number(amount),
    name: String(name).slice(0,60),
    url: String(url).slice(0,500),
    description: String(description).slice(0,240),
    category: String(category || "Другое").slice(0,40),
    createdAt: new Date().toISOString(),
    active: true
  };

  db.ads.push(ad);
  save(db);

  res.json({
    ok:true,
    message:"Реклама отправлена на модерацию."
  });
});

app.get("/api/ads",(req,res)=>{
  const db = load();
  res.json(db.ads.filter(x => x.active));
});

app.get("/api/recent-purchases", (req,res)=>{
  const db = load();
  const rows = Object.entries(db.orders)
    .filter(([,o]) => o?.paid)
    .map(([code,o]) => ({ code, amount:Number(o.amount), paidAt:o.paidAt || o.createdAt }))
    .sort((a,b)=>new Date(b.paidAt)-new Date(a.paidAt))
    .slice(0,12);
  res.json(rows);
});

app.get("/api/reviews", (req,res)=>{
  const db = load();
  res.json((db.reviews || []).filter(x => x.approved !== false).slice(-30).reverse());
});

app.post("/api/reviews", (req,res)=>{
  const {code,name,text,rating} = req.body || {};
  const db = load();
  const order = db.orders[String(code || "").trim()];
  const cleanName = String(name || "").trim().slice(0,30);
  const cleanText = String(text || "").trim().slice(0,300);
  const stars = Number(rating);
  if(!order?.paid) return res.status(403).json({ok:false,message:"Отзыв можно оставить только после подтверждённой оплаты."});
  if(!cleanName || !cleanText || !Number.isInteger(stars) || stars<1 || stars>5) return res.status(400).json({ok:false,message:"Заполни имя, текст и оценку от 1 до 5."});
  db.reviews = db.reviews || [];
  if(db.reviews.some(x=>x.code===String(code).trim())) return res.status(409).json({ok:false,message:"Для этого заказа отзыв уже оставлен."});
  db.reviews.push({id:"rev_"+Date.now(),code:String(code).trim(),name:cleanName,text:cleanText,rating:stars,createdAt:new Date().toISOString(),approved:true});
  save(db);
  res.json({ok:true,message:"Спасибо! Отзыв опубликован."});
});



// Minecraft Java directory + public player lookup.
const JAVA_SERVERS = [
  {name:'ReallyWorld', host:'mc.reallyworld.ru', versions:'1.16–1.21', tags:'Выживание • Анархия • PvP', icon:'RW'},
  {name:'FunTime', host:'play.funtime.su', versions:'1.8–1.21', tags:'Анархия • Гриф • Мини-игры', icon:'FT'},
  {name:'MineBlaze', host:'mc.mineblaze.net', versions:'1.8–1.21', tags:'BedWars • SkyWars • PvP', icon:'MB'},
  {name:'HolyWorld', host:'hub.holyworld.ru', versions:'Java', tags:'Мини-игры • Выживание', icon:'HW'},
  {name:'Hypixel', host:'mc.hypixel.net', versions:'1.8+', tags:'BedWars • SkyBlock • Duels', icon:'HP'},
  {name:'CubeCraft', host:'play.cubecraft.net', versions:'1.8+', tags:'SkyWars • EggWars • Games', icon:'CC'},
  {name:'Wynncraft', host:'play.wynncraft.com', versions:'Java', tags:'MMORPG • Quests • Adventure', icon:'WC'},
  {name:'2b2t', host:'2b2t.org', versions:'1.20+', tags:'Anarchy • Survival', icon:'2B'},
  {name:'JartexNetwork', host:'play.jartexnetwork.com', versions:'1.8+', tags:'BedWars • SkyBlock • PvP', icon:'JN'},
  {name:'BlocksMC', host:'blocksmc.com', versions:'1.8+', tags:'BedWars • SkyWars • Practice', icon:'BM'},
  {name:'Minemen Club', host:'eu.minemen.club', versions:'1.8+', tags:'Practice • PvP • Duels', icon:'MM'},
  {name:'PikaNetwork', host:'play.pika-network.net', versions:'1.8+', tags:'BedWars • Survival • SkyBlock', icon:'PN'}
];

app.get('/api/java-servers', (req,res)=>res.json(JAVA_SERVERS));

app.get('/api/java-status', async (req,res)=>{
  const host=String(req.query.host||'').trim().toLowerCase();
  if(!/^[a-z0-9.-]+$/.test(host)) return res.status(400).json({online:false,message:'invalid_host'});
  try{
    const r=await fetch('https://api.mcsrvstat.us/3/'+encodeURIComponent(host),{headers:{accept:'application/json'}});
    if(!r.ok) throw new Error('status '+r.status);
    const d=await r.json();
    res.json({online:!!d.online,players:d.players||{online:0,max:0},version:d.version||'',motd:Array.isArray(d.motd?.clean)?d.motd.clean.join(' '):'',icon:d.icon||null});
  }catch(e){res.status(503).json({online:false,message:'status_unavailable'});}
});

app.get('/api/player-lookup', async (req,res)=>{
  const nick=String(req.query.nick||'').trim();
  if(!/^[A-Za-z0-9_]{3,16}$/.test(nick)) return res.status(400).json({ok:false,message:'Некорректный Minecraft-ник.'});
  try{
    const r=await fetch('https://api.mojang.com/users/profiles/minecraft/'+encodeURIComponent(nick),{headers:{accept:'application/json'}});
    if(r.status===204 || r.status===404) return res.status(404).json({ok:false,message:'Публичный профиль не найден.'});
    if(!r.ok) throw new Error('mojang '+r.status);
    const d=await r.json();
    res.json({ok:true,name:d.name,uuid:d.id});
  }catch(e){res.status(503).json({ok:false,message:'Публичный API Minecraft временно недоступен.'});}
});

app.post('/api/recovery-requests',(req,res)=>{
  const {nick,server,problem,screenshot}=req.body||{};
  const cleanNick=String(nick||'').trim().slice(0,16);
  const cleanServer=String(server||'').trim().slice(0,60);
  const cleanProblem=String(problem||'').trim().slice(0,700);
  const cleanShot=String(screenshot||'');
  if(!/^[A-Za-z0-9_]{3,16}$/.test(cleanNick) || !cleanServer || !cleanProblem) return res.status(400).json({ok:false,message:'Заполни ник, сервер и описание проблемы.'});
  if(cleanShot && !/^data:image\/(png|jpeg|webp);base64,/.test(cleanShot)) return res.status(400).json({ok:false,message:'Разрешён только PNG/JPEG/WebP скриншот.'});
  if(cleanShot.length>4_500_000) return res.status(400).json({ok:false,message:'Скриншот слишком большой.'});
  const db=load(); db.recoveryRequests=db.recoveryRequests||[];
  const id=String(1000+Math.floor(Math.random()*9000));
  let screenshotFile='';
  if(cleanShot){
    const m=cleanShot.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/s);
    if(m){
      const ext=m[1]==='jpeg'?'jpg':m[1];
      const dir=path.join(__dirname,'recovery_uploads'); fs.mkdirSync(dir,{recursive:true});
      screenshotFile=path.join('recovery_uploads',id+'_'+crypto.randomBytes(4).toString('hex')+'.'+ext);
      fs.writeFileSync(path.join(__dirname,screenshotFile),Buffer.from(m[2],'base64'));
    }
  }
  db.recoveryRequests.push({id,nick:cleanNick,server:cleanServer,problem:cleanProblem,screenshotFile,createdAt:new Date().toISOString(),status:'UNDER REVIEW'});
  save(db);
  res.json({ok:true,id,message:'Заявка создана. Свяжитесь с администратором в Telegram, указав номер заявки.'});
});

app.listen(PORT,()=>{
  console.log(`PUSH CLXN running on http://localhost:${PORT}`);
});
