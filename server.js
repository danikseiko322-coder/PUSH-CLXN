// PUSH CLXN — card checkout backend
// Hosted checkout integration. No customer card details are stored by this server.
//
// Recommended production flow:
//   PUSH CLXN -> hosted checkout (Stripe or Barclaycard) -> webhook -> order paid
//
// This file supports Stripe Checkout out of the box.
// For Barclays/Barclaycard Smartpay, use the hosted-payment-page adapter described in
// BARCLAYCARD_SETUP.txt after obtaining merchant credentials.
//
// IMPORTANT: never put secret payment keys in index.html.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(__dirname, "data.json");

// Basic abuse protection. Stripe/Radar remains the primary fraud layer.
const rateBuckets = new Map();
function rateLimit(req, keyPrefix, limit=12, windowMs=60_000){
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const key = keyPrefix+":"+ip;
  const now = Date.now();
  const row = rateBuckets.get(key) || {start:now,count:0};
  if(now-row.start >= windowMs){ row.start=now; row.count=0; }
  row.count++; rateBuckets.set(key,row);
  return row.count <= limit;
}

function load(){
  try { return JSON.parse(fs.readFileSync(DATA, "utf8")); }
  catch { return {orders:{}, ads:[], reviews:[], recoveryRequests:[]}; }
}
function save(db){ fs.writeFileSync(DATA, JSON.stringify(db, null, 2)); }

function clean(v,max=300){ return String(v ?? "").trim().slice(0,max); }
function currency(){
  const c=String(process.env.SHOP_CURRENCY || "rub").trim().toLowerCase();
  return /^[a-z]{3}$/.test(c) ? c : "gbp";
}
function extractStripeKey(raw){
  // Accept a key pasted on a single line, ignoring blank/comment lines.
  // Supports normal secret keys (sk_...) and restricted secret keys (rk_...).
  const lines=String(raw||"").replace(/^\\uFEFF/,"").split(/\\r?\\n/);
  for(const line of lines){
    const v=line.trim();
    if(!v || v.startsWith("#")) continue;
    const m=v.match(/^(sk_(?:live|test)_[A-Za-z0-9]+|rk_(?:live|test)_[A-Za-z0-9]+)$/);
    if(m) return m[1];
  }
  return "";
}
function stripeSecretKey(){
  const envKey=extractStripeKey(process.env.STRIPE_SECRET_KEY);
  if(envKey) return envKey;
  try {
    const fileKey=extractStripeKey(fs.readFileSync(path.join(__dirname,"stripe-key.txt"),"utf8"));
    return fileKey;
  } catch { return ""; }
}
function stripeConfigured(){ return Boolean(stripeSecretKey()); }
function stripePublishable(){ return clean(process.env.STRIPE_PUBLISHABLE_KEY); }

app.use((req,res,next)=>{
  const blocked=/\.(env|git)|package-lock\.json$|stripe-key\.txt$/i.test(req.path);
  if(blocked) return res.status(404).end();
  next();
});
app.use(express.static(__dirname));

/* Parse webhook body before the global JSON parser so Stripe signatures remain verifiable. */
app.use("/api/stripe-webhook", express.raw({type:"application/json"}));

/* ---------- Stripe Checkout ---------- */

async function stripeRequest(endpoint, params, idempotencyKey=""){
  const key=stripeSecretKey();
  const r=await fetch("https://api.stripe.com/v1/"+endpoint,{
    method:"POST",
    headers:{
      Authorization:"Bearer "+key,
      "Content-Type":"application/x-www-form-urlencoded",
      ...(idempotencyKey ? {"Idempotency-Key": idempotencyKey} : {})
    },
    body:new URLSearchParams(params)
  });
  const body=await r.json().catch(()=>({}));
  if(!r.ok){
    const e=new Error(body?.error?.message || "Stripe API error");
    e.status=r.status; e.body=body; throw e;
  }
  return body;
}

function amountMinor(amount){
  // RUB uses kopecks (100 minor units per 1 RUB), same as GBP/USD/EUR.
  return Math.round(Number(amount)*100);
}

function baseUrl(req){
  const configured=clean(process.env.PUBLIC_BASE_URL);
  if(configured && !/^https?:\/\/localhost(?::\d+)?$/i.test(configured)) return configured.replace(/\/+$/,"");
  const proto=(req.headers["x-forwarded-proto"]||req.protocol||"http").split(",")[0];
  return proto+"://"+req.get("host");
}

app.use(express.json({limit:"6mb"}));

const PRODUCTS = {
  day:{title:"Реклама • 24 часа",amount:120,durationMs:24*60*60*1000},
  "3days":{title:"Реклама • 3 дня",amount:250,durationMs:3*24*60*60*1000},
  week:{title:"Реклама • 7 дней",amount:350,durationMs:7*24*60*60*1000},
  month:{title:"Реклама • 30 дней",amount:650,durationMs:30*24*60*60*1000},
  forever:{title:"Вечная реклама",amount:1000,durationMs:null},
  pin:{title:"Закреп • 7 дней",amount:700,durationMs:7*24*60*60*1000},
  vip:{title:"VIP витрина • 30 дней",amount:1200,durationMs:30*24*60*60*1000},
  tg:{title:"Telegram • 7 дней",amount:350,durationMs:7*24*60*60*1000},
  tiktok:{title:"TikTok • 7 дней",amount:450,durationMs:7*24*60*60*1000},
  clothes:{title:"Бренд / одежда • 7 дней",amount:500,durationMs:7*24*60*60*1000},
  site:{title:"Сайт / проект • 7 дней",amount:500,durationMs:7*24*60*60*1000},
  assistant:{title:"Помощник сайта",amount:4000,durationMs:null},
  "discord-bot":{title:"Discord-бот",amount:250,durationMs:null},
  "discord-design":{title:"Оформление Discord-сервера",amount:350,durationMs:null},
  "discord-moderation":{title:"Базовая защита Discord-сервера",amount:400,durationMs:null},
  "discord-pack":{title:"Discord-пакет",amount:750,durationMs:null},
  "discord-setup":{title:"Настройка Discord-сервера",amount:500,durationMs:null},
  "bot-upgrade":{title:"Расширение Discord-бота",amount:600,durationMs:null},
  "bundle-start":{title:"Старт проекта",amount:600,durationMs:null},
  "bundle-discord":{title:"Discord Launch",amount:950,durationMs:null},
  "bundle-max":{title:"Пакет Максимум",amount:1800,durationMs:null}
};

app.post("/api/create-checkout", async (req,res)=>{
  if(!rateLimit(req,"checkout",8,60_000)) return res.status(429).json({ok:false,error:"rate_limited",message:"Слишком много попыток. Подожди немного и попробуй снова."});
  if(!stripeConfigured()){
    return res.status(503).json({ok:false,error:"payment_not_configured",message:"Платёжный шлюз временно не активирован. Попробуйте ещё раз позже."});
  }
  const {productId,customerName=""}=req.body||{};
  const product=PRODUCTS[String(productId||"")];
  if(!product) return res.status(400).json({ok:false,error:"invalid_product"});

  const code="PUSH-"+crypto.randomBytes(4).toString("hex").toUpperCase()+"-"+Date.now().toString().slice(-5);
  const db=load();
  db.orders[code]={code,productId:String(productId),title:product.title,amount:product.amount,currency:currency(),customerName:clean(customerName,80),paid:false,createdAt:new Date().toISOString()};
  save(db);

  try{
    const root=baseUrl(req);
    // Use Stripe's hosted Checkout page. This is more reliable for a local
    // development site than embedded Checkout and keeps card data off PUSH CLXN.
    const sessionParams={
      "mode":"payment",
      "success_url":root+"/payment.html?payment=success&order="+encodeURIComponent(code),
      "cancel_url":root+"/payment.html?payment=cancelled&order="+encodeURIComponent(code),
      "locale":"auto",
      // No forced phone or billing address. Stripe collects only what a selected payment method requires.
      // Let Checkout choose the payment methods available to this customer/account.
      "adaptive_pricing[enabled]":"true",
      "expires_at":String(Math.floor(Date.now()/1000)+30*60),
      "client_reference_id":code,
      "payment_intent_data[description]":"PUSH CLXN order "+code,
      "payment_intent_data[metadata][order_code]":code,
      "payment_intent_data[metadata][product_id]":String(productId),
      "line_items[0][price_data][currency]":currency(),
      "line_items[0][price_data][product_data][name]":product.title,
      "line_items[0][price_data][product_data][description]":"PUSH CLXN • "+code,
      "line_items[0][price_data][unit_amount]":String(amountMinor(product.amount)),
      "line_items[0][quantity]":"1",
      "metadata[order_code]":code,
      "metadata[product_id]":String(productId)
    };
    const session=await stripeRequest("checkout/sessions",sessionParams,"pushclxn-"+code);
    db.orders[code].checkoutSessionId=session.id;
    save(db);
    res.json({ok:true,code,url:session.url||null,amount:product.amount,title:product.title,currency:currency()});
  }catch(e){
    console.error("[stripe-create]",e.message);
    delete db.orders[code]; save(db);
    const raw=String(e.message||"");
    const safe=raw.replace(/(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/g,"[hidden-key]").slice(0,500);
    let message="Не удалось открыть защищённую форму оплаты.";
    if(/currency|presentment|rub/i.test(raw)) message="Stripe не разрешил эту валюту для данного платежа. Попробуем локальную валюту через Checkout, если она доступна.";
    else if(/authentication|api key|secret key|invalid.*key/i.test(raw)) message="Stripe не принял Secret Key. Нужен активный Secret Key вида sk_live_... или sk_test_....";
    else if(/permission|restricted/i.test(raw)) message="Stripe-ключ не имеет нужных прав для Checkout Sessions.";
    res.status(502).json({ok:false,error:"checkout_create_failed",message,details:safe});
  }
});

app.get("/api/check-payment",async(req,res)=>{
  const code=clean(req.query.code,80);
  if(!code) return res.status(400).json({paid:false,error:"invalid_order"});
  const db=load();
  const order=db.orders[code];
  if(!order) return res.status(404).json({paid:false,error:"order_not_found"});
  if(order.paid) return res.json({paid:true});

  if(!stripeConfigured() || !order.checkoutSessionId){
    return res.json({paid:false,waiting:true});
  }

  try{
    const key=stripeSecretKey();
    const r=await fetch("https://api.stripe.com/v1/checkout/sessions/"+encodeURIComponent(order.checkoutSessionId),{
      headers:{Authorization:"Bearer "+key}
    });
    const s=await r.json();
    if(!r.ok) throw new Error(s?.error?.message||"Stripe status error");
    if(s.status==="complete" && s.payment_status==="paid"){
      order.paid=true;
      order.paidAt=new Date().toISOString();
      order.paymentId=s.payment_intent||s.id;
      db.orders[code]=order;
      save(db);
      return res.json({paid:true});
    }
    return res.json({paid:false,waiting:true,status:s.payment_status||"unpaid",sessionStatus:s.status||"open"});
  }catch(e){
    console.error("[stripe-check]",e.message);
    return res.status(503).json({paid:false,error:"payment_check_unavailable"});
  }
});

app.get("/api/order/:code",(req,res)=>{
  const code=clean(req.params.code,80);
  const order=load().orders[code];
  if(!order) return res.status(404).json({ok:false,error:"order_not_found"});
  res.json({ok:true,code:order.code,productId:order.productId,title:order.title,amount:order.amount,currency:order.currency,paid:!!order.paid,paidAt:order.paidAt||null});
});

app.get("/api/payment-config",(req,res)=>{
  res.json({
    ok:true,
    provider:"stripe",
    configured:stripeConfigured(),
    currency:currency(),
    hostedCheckout:true,
    addressRequired:false,
    phoneRequired:false,
    applePay:true
  });
});

app.get("/api/health",(req,res)=>{
  res.json({ok:true,service:"PUSH CLXN card checkout backend",time:new Date().toISOString()});
});

app.get("/api/status",(req,res)=>{
  res.json({
    ok:true,
    paymentProvider:"stripe",
    paymentChecker:stripeConfigured()?"configured":"not_configured"
  });
});

/* Stripe webhook.
   For a first working deployment the polling endpoint above also confirms paid
   Checkout Sessions. The webhook is included for robust server-side fulfilment.
*/
app.post("/api/stripe-webhook",(req,res)=>{
  // Full Stripe signature verification requires the endpoint secret.
  // We fail closed if it is not configured.
  const secret=clean(process.env.STRIPE_WEBHOOK_SECRET);
  if(!secret) return res.status(503).send("Webhook secret not configured");

  const sig=String(req.headers["stripe-signature"]||"");
  const body=req.body;
  try{
    const sigParts=sig.split(",");
    const tsPart=sigParts.find(x=>x.startsWith("t="));
    const ts=Number(tsPart?.slice(2));
    const signatures=sigParts.filter(x=>x.startsWith("v1=")).map(x=>x.slice(3));
    if(!ts || !signatures.length) throw new Error("invalid signature");
    if(Math.abs(Date.now()/1000-ts)>300) throw new Error("stale signature");
    const expected=crypto.createHmac("sha256",secret).update(ts+"."+body.toString()).digest("hex");
    const valid=signatures.some(v=>v.length===expected.length && crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(v)));
    if(!valid) throw new Error("bad signature");

    const event=JSON.parse(body.toString("utf8"));
    if(event.type==="checkout.session.completed" || event.type==="checkout.session.async_payment_succeeded"){
      const s=event.data?.object||{};
      const code=clean(s.metadata?.order_code || s.client_reference_id,80);
      const db=load();
      if(code && db.orders[code] && s.payment_status==="paid"){
        db.orders[code].paid=true;
        db.orders[code].paidAt=new Date().toISOString();
        db.orders[code].paymentId=s.payment_intent||s.id;
        save(db);
      }
    }
    if(event.type==="payment_intent.succeeded"){
      const pi=event.data?.object||{};
      const code=clean(pi.metadata?.order_code,80);
      const db=load();
      if(code && db.orders[code]){
        db.orders[code].paid=true;
        db.orders[code].paidAt=new Date().toISOString();
        db.orders[code].paymentId=pi.id;
        save(db);
      }
    }
    res.json({received:true});
  }catch(e){
    console.error("[stripe-webhook]",e.message);
    return res.status(400).send("Invalid webhook");
  }
});

app.post("/api/submit-ad",(req,res)=>{
  if(!rateLimit(req,"submit-ad",10,60_000)) return res.status(429).json({ok:false,message:"Слишком много запросов. Попробуй позже."});
  const {code,plan,amount,name,url,description,category} = req.body || {};
  const db = load();
  const order = db.orders[code];

  const expectedProduct = PRODUCTS[String(order?.productId || "")];
  if(!order?.paid || !expectedProduct || Number(order.amount) !== Number(expectedProduct.amount) || Number(order.amount) !== Number(amount) || String(order.productId) !== String(plan)){
    return res.status(403).json({
      ok:false,
      message:"Оплата этого заказа ещё не подтверждена или данные заказа не совпадают."
    });
  }

  if(!name || !url || !description){
    return res.status(400).json({
      ok:false,
      message:"Заполни все поля."
    });
  }

  let parsedUrl;
  try { parsedUrl = new URL(String(url).trim()); } catch { parsedUrl = null; }
  if(!parsedUrl || !/^https?:$/.test(parsedUrl.protocol)){
    return res.status(400).json({ok:false,message:"Ссылка должна начинаться с https:// или http://"});
  }

  if(order.fulfilledAt){
    return res.status(409).json({ok:false,message:"Этот оплаченный заказ уже использован."});
  }

  const now = new Date();
  const expiresAt = expectedProduct.durationMs ? new Date(now.getTime()+expectedProduct.durationMs).toISOString() : null;
  const ad = {
    id: "ad_" + Date.now(),
    code,
    plan,
    amount: Number(amount),
    name: String(name).slice(0,60),
    url: parsedUrl.href.slice(0,500),
    description: String(description).slice(0,240),
    category: String(category || "Другое").slice(0,40),
    createdAt: now.toISOString(),
    expiresAt,
    active: true
  };

  db.ads.push(ad);
  order.fulfilledAt = new Date().toISOString();
  db.orders[code] = order;
  save(db);

  res.json({
    ok:true,
    message:"Реклама отправлена на модерацию."
  });
});

app.get("/api/ads",(req,res)=>{
  const db = load();
  const now = Date.now();
  let changed = false;
  const ads = (db.ads || []).map(ad=>{
    if(ad.active && ad.expiresAt && new Date(ad.expiresAt).getTime() <= now){ ad.active=false; changed=true; }
    return ad;
  });
  if(changed){ db.ads=ads; save(db); }
  res.json(ads.filter(x => x.active));
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

app.get("/api/site-stats", (req,res)=>{
  const db = load();
  const paid = Object.values(db.orders || {}).filter(o => o && o.paid);
  const activeAds = (db.ads || []).filter(a => a && a.active && (!a.expiresAt || new Date(a.expiresAt).getTime() > Date.now())).length;
  const reviews = (db.reviews || []).filter(r => r && r.approved !== false);
  const averageRating = reviews.length ? reviews.reduce((sum,r)=>sum + Number(r.rating || 0),0) / reviews.length : 0;
  const counts = {};
  for (const order of paid) counts[order.productId] = (counts[order.productId] || 0) + 1;
  let popularProduct = null;
  for (const [productId,count] of Object.entries(counts)) {
    const p = PRODUCTS[productId];
    if (!p) continue;
    if (!popularProduct || count > popularProduct.count) popularProduct = {productId,title:p.title,count};
  }
  res.json({
    ok:true,
    paidOrders:paid.length,
    activeAds,
    reviews:reviews.length,
    averageRating:averageRating ? Number(averageRating.toFixed(2)) : 0,
    popularProduct
  });
});

app.get("/api/reviews", (req,res)=>{
  const db = load();
  res.json((db.reviews || []).filter(x => x.approved !== false).slice(-30).reverse());
});

app.post("/api/reviews", (req,res)=>{
  const {code,name,text,rating,imageData=""} = req.body || {};
  const db = load();
  const order = db.orders[String(code || "").trim()];
  const cleanName = String(name || "").trim().slice(0,30);
  const cleanText = String(text || "").trim().slice(0,300);
  const stars = Number(rating);
  if(!order?.paid) return res.status(403).json({ok:false,message:"Отзыв можно оставить только после подтверждённой оплаты."});
  if(!cleanName || !cleanText || !Number.isInteger(stars) || stars<1 || stars>5) return res.status(400).json({ok:false,message:"Заполни имя, текст и оценку от 1 до 5."});
  let safeImage="";
  if(imageData){
    const raw=String(imageData);
    if(raw.length>1600000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) return res.status(400).json({ok:false,message:"Скриншот должен быть PNG, JPG или WebP и не больше 1.2 МБ."});
    safeImage=raw;
  }
  db.reviews = db.reviews || [];
  if(db.reviews.some(x=>x.code===String(code).trim())) return res.status(409).json({ok:false,message:"Для этого заказа отзыв уже оставлен."});
  db.reviews.push({id:"rev_"+Date.now(),code:String(code).trim(),name:cleanName,text:cleanText,rating:stars,imageData:safeImage,createdAt:new Date().toISOString(),approved:true});
  save(db);
  res.json({ok:true,message:"Спасибо! Отзыв опубликован."});
});



app.listen(PORT,()=>{
  console.log(`PUSH CLXN running on http://localhost:${PORT}`);
});
