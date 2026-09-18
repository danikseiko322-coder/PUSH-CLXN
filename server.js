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
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(__dirname, "data.json");

app.use(express.json({limit:"32kb"}));
app.use(express.static(__dirname));

function load(){
  try {
    return JSON.parse(fs.readFileSync(DATA, "utf8"));
  } catch {
    return {orders:{}, ads:[]};
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

app.listen(PORT,()=>{
  console.log(`PUSH CLXN running on http://localhost:${PORT}`);
});
