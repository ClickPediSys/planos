'use strict';

/**
 * ClickPedi — AbacatePay V2 Server
 * Substitui completamente o cakto-webhook.js
 * Porta: 3004
 */

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const admin   = require('firebase-admin');
const cors    = require('cors');

// ── Firebase Admin ─────────────────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}');
} catch (e) {
  console.error('❌ FIREBASE_CREDENTIALS inválido:', e.message);
  process.exit(1);
}
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ── Configuração ───────────────────────────────────────────────────
const PORT                = parseInt(process.env.PORT || '3004');
const ABACATEPAY_API_KEY  = process.env.ABACATEPAY_API_KEY || '';
const ABACATEPAY_BASE     = 'https://api.abacatepay.com/v2';
const WEBHOOK_SECRET      = process.env.ABACATEPAY_WEBHOOK_SECRET || '';

const ABACATEPAY_SHARED_KEY = 't9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9';

const PLAN_PRICES = { basico:3990, profissional:4990, premium:5990 };
const PLAN_NAMES  = { basico:'Básico', profissional:'Profissional', premium:'Premium' };
const DISCOUNTS   = { 1:0.00, 2:0.05, 3:0.10, 4:0.15, 5:0.20, 6:0.30 };

const productCache = {};

const app = express();
app.use(cors({ origin: '*' }));
app.use('/webhooks/abacatepay', express.raw({ type: '*/*', limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

function log(msg, data) {
  const ts = new Date().toISOString().replace('T',' ').slice(0,19);
  if(data!==undefined){ console.log(`[${ts}] ${msg}`, typeof data==='object'?JSON.stringify(data):data); }
  else { console.log(`[${ts}] ${msg}`); }
}

const abacateAPI = axios.create({
  baseURL: ABACATEPAY_BASE, timeout: 20000,
  headers: { Authorization:`Bearer ${ABACATEPAY_API_KEY}`, 'Content-Type':'application/json' },
});

function calcularTotal(plano, meses) {
  const precoMensal = PLAN_PRICES[plano];
  if(!precoMensal) throw new Error(`Plano inválido: ${plano}`);
  const m = parseInt(meses);
  if(m<1||m>6) throw new Error(`Meses inválido: ${meses}`);
  const desconto = DISCOUNTS[m]||0;
  const total = Math.round(precoMensal * m * (1-desconto));
  return { total, desconto, precoMensal, meses:m };
}

async function getOrCreateProduct(plano, meses) {
  const cacheKey = `${plano}-${meses}`;
  if(productCache[cacheKey]) return productCache[cacheKey];
  const externalId = `clickpedi-${plano}-${meses}m`;
  const { total, desconto, meses:m } = calcularTotal(plano, meses);
  try {
    const r = await abacateAPI.get(`/products/get?externalId=${externalId}`);
    if(r.data?.data?.id){ productCache[cacheKey]=r.data.data.id; log(`📦 Produto reutilizado: ${r.data.data.id}`); return r.data.data.id; }
  } catch(e){}
  const nomeMeses = m===1?'1 mês':`${m} meses`;
  const descPct   = desconto>0?` (${Math.round(desconto*100)}% OFF)`:'';
  const r = await abacateAPI.post('/products/create',{
    externalId, currency:'BRL', price:total,
    name:`ClickPedi ${PLAN_NAMES[plano]} – ${nomeMeses}${descPct}`,
    description:`Assinatura ClickPedi Plano ${PLAN_NAMES[plano]} por ${nomeMeses}`,
  });
  const prodId = r.data.data.id;
  productCache[cacheKey]=prodId;
  log(`✅ Produto criado: ${prodId} | R$${(total/100).toFixed(2)}`);
  return prodId;
}

function verificarAssinatura(rawBody, signature) {
  if(!signature) return false;
  const keys = [WEBHOOK_SECRET, ABACATEPAY_SHARED_KEY].filter(Boolean);
  for(const key of keys){
    try{
      const hmac=crypto.createHmac('sha256',key); hmac.update(rawBody);
      const expected=hmac.digest('hex');
      if(crypto.timingSafeEqual(Buffer.from(expected.padEnd(64)),Buffer.from(signature.padEnd(64)))) return true;
    }catch(_){}
  }
  return false;
}

function calcularVencimento(planoVencimentoAtual, meses) {
  const agora=new Date(); const vencAtual=planoVencimentoAtual?.toDate?.()??null;
  if(vencAtual&&vencAtual>agora) return new Date(vencAtual.getTime()+meses*30*24*60*60*1000);
  return new Date(agora.getTime()+meses*30*24*60*60*1000);
}

async function ativarPlano(lojaId, plano, meses, valor, transactionId) {
  const lojaRef=db.collection('lojas').doc(lojaId);
  const lojaSnap=await lojaRef.get();
  if(!lojaSnap.exists) throw new Error(`Loja não encontrada: ${lojaId}`);
  const loja=lojaSnap.data(); const agora=new Date();
  const novoVencimento=calcularVencimento(loja.planoVencimento,meses);
  await lojaRef.update({
    plano, planoAtivo:true,
    planoVencimento: admin.firestore.Timestamp.fromDate(novoVencimento),
    ultimoPagamento: admin.firestore.FieldValue.serverTimestamp(),
    ultimoTransactionId: transactionId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection('assinaturas').add({
    lojaId, plano, meses, status:'ativo', valor,
    desconto: DISCOUNTS[meses]||0, transactionId, gateway:'abacatepay',
    dataInicio: admin.firestore.Timestamp.fromDate(agora),
    dataVencimento: admin.firestore.Timestamp.fromDate(novoVencimento),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  log(`🎉 Plano ${plano} ativado para ${lojaId} até ${novoVencimento.toLocaleDateString('pt-BR')}`);
  return novoVencimento;
}

async function salvarPagamento(lojaId, dados) {
  await db.collection('pagamentos').add({ lojaId, gateway:'abacatepay', createdAt:admin.firestore.FieldValue.serverTimestamp(), ...dados });
}

async function salvarLog(evento, payload, lojaId, status, detalhes) {
  try { await db.collection('abacatepay_logs').add({ evento, lojaId:lojaId||null, status, detalhes:detalhes||null, payload:JSON.stringify(payload||{}).slice(0,8000), createdAt:admin.firestore.FieldValue.serverTimestamp() }); }
  catch(e){ log('❌ Erro ao salvar log:',e.message); }
}

// POST /criar-cobranca
app.post('/criar-cobranca', async(req,res)=>{
  try {
    const { lojaId, lojaNome, plano, meses, email, nome } = req.body;
    if(!lojaId) return res.status(400).json({error:'lojaId obrigatório'});
    if(!plano||!PLAN_PRICES[plano]) return res.status(400).json({error:`Plano inválido: ${plano}`});
    const mesesNum=parseInt(meses||'1');
    if(mesesNum<1||mesesNum>6) return res.status(400).json({error:'Meses deve ser entre 1 e 6'});

    // Idempotência
    const corte=new Date(Date.now()-5*60*1000);
    const existente=await db.collection('cobrancas_pendentes')
      .where('lojaId','==',lojaId).where('plano','==',plano).where('meses','==',mesesNum)
      .where('status','==','PENDING').orderBy('createdAt','desc').limit(1).get();
    if(!existente.empty){
      const doc=existente.docs[0].data();
      const criado=doc.createdAt?.toDate?.()??new Date(0);
      if(criado>corte){
        log(`♻️  Reutilizando cobrança: ${doc.checkoutId}`);
        return res.json({success:true,checkoutId:doc.checkoutId,checkoutUrl:doc.checkoutUrl,valor:doc.valor,desconto:doc.desconto,plano:doc.plano,meses:doc.meses,reutilizado:true});
      }
    }

    const { total, desconto } = calcularTotal(plano, mesesNum);
    log(`🛒 Nova cobrança: ${lojaId}|${plano}|${mesesNum}m|R$${(total/100).toFixed(2)}`);
    const productId = await getOrCreateProduct(plano, mesesNum);
    const externalId = `${lojaId}|${plano}|${mesesNum}m|${Date.now()}`;

    const checkoutBody = {
      items:[{id:productId,quantity:1}], externalId,
      returnUrl:'https://clickpedi.site/painel/dashboard',
      completionUrl:'https://clickpedi.site/painel/dashboard',
      metadata:{ lojaId:{value:lojaId}, lojaNome:{value:lojaNome||''}, plano:{value:plano}, meses:{value:String(mesesNum)} },
    };
    if(email&&nome) checkoutBody.customer={email,name:nome};

    const resp=await abacateAPI.post('/checkouts/create',checkoutBody);
    const checkoutData=resp.data.data;

    await db.collection('cobrancas_pendentes').doc(checkoutData.id).set({
      lojaId, lojaNome:lojaNome||'', plano, meses:mesesNum,
      valor:total, desconto, email:email||'',
      status:'PENDING', checkoutId:checkoutData.id, externalId,
      checkoutUrl:checkoutData.url,
      createdAt:admin.firestore.FieldValue.serverTimestamp(),
    });

    log(`✅ Checkout criado: ${checkoutData.id}`);
    res.json({success:true, checkoutId:checkoutData.id, checkoutUrl:checkoutData.url, valor:total, desconto, plano, meses:mesesNum});
  } catch(err) {
    log('❌ /criar-cobranca:', err.response?.data||err.message);
    res.status(500).json({error:'Erro ao criar cobrança', details:err.message});
  }
});

// GET /status-cobranca/:checkoutId
app.get('/status-cobranca/:checkoutId', async(req,res)=>{
  try {
    const doc=await db.collection('cobrancas_pendentes').doc(req.params.checkoutId).get();
    if(!doc.exists) return res.json({success:true,status:'NOT_FOUND',pago:false});
    const d=doc.data();
    res.json({success:true, status:d.status, lojaId:d.lojaId, plano:d.plano, meses:d.meses, pago:d.status==='PAID'});
  } catch(err){ res.status(500).json({error:'Erro ao verificar status'}); }
});

// GET /historico-pagamentos/:lojaId
app.get('/historico-pagamentos/:lojaId', async(req,res)=>{
  try {
    const snap=await db.collection('pagamentos').where('lojaId','==',req.params.lojaId).orderBy('createdAt','desc').limit(20).get();
    const pagamentos=snap.docs.map(d=>{
      const data=d.data();
      return { id:d.id, plano:data.plano, meses:data.meses, valor:data.valor, desconto:data.desconto, status:data.status, metodo:data.metodo||'PIX', transactionId:data.transactionId, createdAt:data.createdAt?.toDate?.()?.toISOString()??null };
    });
    res.json({success:true, pagamentos});
  } catch(err){ res.status(500).json({error:'Erro ao buscar histórico'}); }
});

// POST /webhooks/abacatepay
app.post('/webhooks/abacatepay', async(req,res)=>{
  res.status(200).json({received:true});
  const rawBody=Buffer.isBuffer(req.body)?req.body.toString('utf8'):JSON.stringify(req.body);
  let payload; try{ payload=JSON.parse(rawBody); }catch(e){ log('❌ Webhook — JSON inválido'); return; }
  const signature=req.headers['x-webhook-signature']||req.headers['x-abacatepay-signature']||'';
  const evento=payload.event||'';
  log(`📨 Webhook: ${evento}|devMode=${payload.devMode}`);
  if(signature&&!payload.devMode&&!verificarAssinatura(rawBody,signature)) log('⚠️ Assinatura não verificada');
  if(evento!=='billing.paid'){ await salvarLog(evento,payload,null,'ignored','Evento não processado'); return; }

  try {
    const data=payload.data||{}; const billing=data.billing; const pixQrCode=data.pixQrCode;
    let lojaId=null,plano=null,meses=1,transactionId=null,valor=0;

    if(billing){
      transactionId=billing.id; valor=billing.amount;
      if(billing.externalId){ const parts=billing.externalId.split('|'); if(parts.length>=3){ lojaId=parts[0]; plano=parts[1]; meses=parseInt((parts[2]||'1m').replace('m',''))||1; } }
      if(!lojaId){ const pd=await db.collection('cobrancas_pendentes').doc(billing.id).get(); if(pd.exists){ const p=pd.data(); lojaId=p.lojaId; plano=p.plano; meses=p.meses||1; } }
    }
    if(pixQrCode&&!lojaId){
      transactionId=pixQrCode.id; valor=pixQrCode.amount;
      const pd=await db.collection('cobrancas_pendentes').doc(pixQrCode.id).get(); if(pd.exists){ const p=pd.data(); lojaId=p.lojaId; plano=p.plano; meses=p.meses||1; }
    }
    if(!lojaId&&data.metadata){ lojaId=data.metadata?.lojaId?.value||null; plano=data.metadata?.plano?.value||null; meses=parseInt(data.metadata?.meses?.value||'1')||1; }

    if(!lojaId||!plano){ log('❌ lojaId/plano não encontrado'); await salvarLog(evento,payload,null,'error','lojaId/plano não encontrado'); return; }
    if(!PLAN_PRICES[plano]){ log(`❌ Plano desconhecido: ${plano}`); return; }

    // Idempotência
    if(transactionId){ const dup=await db.collection('pagamentos').where('transactionId','==',transactionId).limit(1).get(); if(!dup.empty){ log(`♻️ Duplicado ignorado: ${transactionId}`); return; } }

    log(`💰 Pagamento: ${lojaId}|${plano}|${meses}m|R$${(valor/100).toFixed(2)}`);
    const novoVencimento=await ativarPlano(lojaId,plano,meses,valor,transactionId);
    await salvarPagamento(lojaId,{ transactionId, plano, meses, valor, desconto:DISCOUNTS[meses]||0, status:'PAID', metodo:data.payment?.method||'PIX', vencimento:admin.firestore.Timestamp.fromDate(novoVencimento), webhookId:payload.id });
    try{ await db.collection('cobrancas_pendentes').doc(transactionId).update({status:'PAID',paidAt:admin.firestore.FieldValue.serverTimestamp()}); }catch(_){}
    try{ await db.collection('assinaturas_pendentes').doc(lojaId).delete(); }catch(_){}
    await salvarLog(evento,payload,lojaId,'success',`Plano ${plano} ativado +${meses} meses`);
  } catch(err){ log('❌ Erro webhook:',err.message); await salvarLog(evento,payload,null,'error',err.message); }
});

app.get('/health',(_req,res)=>res.json({status:'ok',service:'abacatepay-server',version:'2.0.0'}));

app.listen(PORT, ()=>{
  log(`🚀 AbacatePay Server v2.0 porta ${PORT}`);
  log(`📡 Webhook: https://clickpedi.site/webhooks/abacatepay`);
  if(!ABACATEPAY_API_KEY) log('⚠️  ABACATEPAY_API_KEY não configurada!');
  if(!WEBHOOK_SECRET)     log('⚠️  ABACATEPAY_WEBHOOK_SECRET não configurada!');
});
