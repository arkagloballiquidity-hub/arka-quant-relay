const express = require('express');
const cors    = require('cors');
const app     = express();

// ─── CORS — solo dominios ARKA autorizados ────────────────────────────────────
app.use(cors({
  origin: [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https:\/\/arka-quant(-[a-z0-9-]+)?\.vercel\.app$/,        // cubre arka-quant-intelligence-nine etc
    /^https:\/\/arka-quant-intelligence(-[a-z0-9]+)?\.vercel\.app$/,
    /^https:\/\/[a-z0-9-]+\.arkaltd\.io$/,
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json());

// ─── API KEY AUTH ────────────────────────────────────────────────────────────
// Sin bypass: si ARKA_API_KEY no está configurada, bloquear todo
const requireAuth = (req, res, next) => {
  const key = process.env.ARKA_API_KEY;
  if (!key) return res.status(503).json({ error: 'Quant endpoints not configured' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${key}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ─── MATH HELPERS ────────────────────────────────────────────────────────────
const mean = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
const std  = arr => { const m=mean(arr); return Math.sqrt(arr.reduce((a,b)=>a+(b-m)**2,0)/arr.length); };
const logRet = closes => closes.slice(1).map((v,i)=>Math.log(v/closes[i]));

function linReg(x, y) {
  const n=x.length, mx=mean(x), my=mean(y);
  const ss=x.reduce((a,xi,i)=>({xy:a.xy+(xi-mx)*(y[i]-my),xx:a.xx+(xi-mx)**2}),{xy:0,xx:0});
  const slope=ss.xy/ss.xx, intercept=my-slope*mx;
  const pred=x.map(xi=>slope*xi+intercept);
  const res=y.map((yi,i)=>yi-pred[i]);
  const ssTot=y.reduce((a,yi)=>a+(yi-my)**2,0);
  const r2=1-res.reduce((a,r)=>a+r**2,0)/ssTot;
  return { pred, r2, stdRes:std(res), slope, intercept };
}

function garch11(rets) {
  const omega=0.000001,alpha=0.1,beta=0.85;
  let s2=Math.pow(std(rets),2);
  const v=[s2];
  for(let i=1;i<rets.length;i++){s2=omega+alpha*rets[i-1]**2+beta*s2;v.push(s2);}
  return {condVol:Math.sqrt(v[v.length-1]),alpha,beta};
}

// ─── YAHOO FETCH ─────────────────────────────────────────────────────────────
async function fetchYahoo(ticker,range='1y',interval='1d') {
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=false`;
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json','Referer':'https://finance.yahoo.com/'}});
  if(!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const json=await r.json();
  const result=json?.chart?.result?.[0];
  if(!result) throw new Error('No data from Yahoo');
  const ts=result.timestamp||[], cl=result.indicators?.quote?.[0]?.close||[];
  return ts.map((t,i)=>({date:new Date(t*1000).toISOString(),close:cl[i]})).filter(d=>d.close!=null);
}

function validTicker(t){ return typeof t==='string'&&/^[A-Z0-9.\-=^]{1,20}$/i.test(t); }

// ─── HEALTH ──────────────────────────────────────────────────────────────────
// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const _cache = new Map();
function getCached(k){ const e=_cache.get(k); if(!e||Date.now()>e.exp){_cache.delete(k);return null;} return e.data; }
function setCached(k,d,ttl=300_000){ _cache.set(k,{data:d,exp:Date.now()+ttl}); }

app.get('/health',(_, res)=>res.json({status:'ok'}));

// ─── LEGACY Yahoo proxy ───────────────────────────────────────────────────────
app.get('/yahoo',requireAuth,async(req,res)=>{
  const{ticker,range='1y',interval='1d'}=req.query;
  if(!ticker||!validTicker(ticker)) return res.status(400).json({error:'ticker required'});
  try{
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=false&events=div%7Csplit`;
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json','Referer':'https://finance.yahoo.com/'}});
    if(!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
    res.json(await r.json());
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── /api/fractal ─────────────────────────────────────────────────────────────
app.get('/api/fractal',requireAuth,async(req,res)=>{
  const{ticker,range='1y'}=req.query;
  if(!ticker||!validTicker(ticker)) return res.status(400).json({error:'ticker required'});
  try{
    const interval=range==='1d'?'5m':range==='5d'?'1h':'1d';
    const data=await fetchYahoo(ticker,range,interval);
    if(data.length<10) return res.status(422).json({error:'Insufficient data'});
    const closes=data.map(d=>d.close),x=closes.map((_,i)=>i);
    const{pred,r2,stdRes,slope}=linReg(x,closes);
    const last=closes[closes.length-1],lastPred=pred[pred.length-1];
    const hiIdx=closes.filter((c,i)=>c>pred[i]+stdRes).length;
    const loIdx=closes.filter((c,i)=>c<pred[i]-stdRes).length;
    let signal,signal_detail;
    if(last<lastPred-stdRes){signal='LONG_BIAS';signal_detail='Precio bajo −1σ — zona de valor, sesgo alcista';}
    else if(last>lastPred+stdRes){signal='SHORT_BIAS';signal_detail='Precio sobre +1σ — zona extendida, sesgo bajista';}
    else{signal='NEUTRAL';signal_detail='Precio dentro de bandas normales';}
    res.json({ticker,range,interval,observations:data.length,current_price:last,
      trend_today:lastPred,sigma:stdRes,r2,slope_direction:slope>0?'uptrend':'downtrend',
      price_vs_trend:last-lastPred,anomalies_hi:hiIdx,anomalies_lo:loIdx,
      signal,signal_detail,last_updated:data[data.length-1].date});
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── /api/anomaly ─────────────────────────────────────────────────────────────
app.get('/api/anomaly',requireAuth,async(req,res)=>{
  const{ticker,interval='5m',period='5d',z_threshold='2'}=req.query;
  if(!ticker||!validTicker(ticker)) return res.status(400).json({error:'ticker required'});
  try{
    const winSize=Math.min(Math.max(parseInt(req.query.window)||20,5),500),zThr=parseFloat(z_threshold)||2;
    const safeRange=period==='1d'?'5d':period;
    const data=await fetchYahoo(ticker,safeRange,interval);
    if(data.length<winSize+2) return res.status(422).json({error:'Insufficient data'});
    const closes=data.map(d=>d.close),rets=logRet(closes);
    const zScores=[],anomHi=[],anomLo=[];
    for(let i=winSize;i<rets.length;i++){
      const win2=rets.slice(i-winSize,i),m=mean(win2),s=std(win2)||1e-10,z=(rets[i]-m)/s;
      const bar={date:data[i+1].date,close:closes[i+1],lr:rets[i],z};
      zScores.push(bar);
      if(z>zThr) anomHi.push(bar);
      if(z<-zThr) anomLo.push(bar);
    }
    const lastZ=zScores[zScores.length-1];
    const allAnom=[...anomHi.map(a=>({...a,dir:'HI'})),...anomLo.map(a=>({...a,dir:'LO'}))]
      .sort((a,b)=>new Date(b.date)-new Date(a.date));
    let trigger,trigger_detail;
    if(lastZ&&lastZ.z<-zThr){trigger='LONG_TRIGGER';trigger_detail=`↓ LO ${interval} z=${lastZ.z.toFixed(2)}`;}
    else if(lastZ&&lastZ.z>zThr){trigger='SHORT_TRIGGER';trigger_detail=`↑ HI ${interval} z=+${lastZ.z.toFixed(2)}`;}
    else{trigger='NONE';trigger_detail='Sin anomalía en la última barra';}
    res.json({ticker,interval,period:safeRange,window:winSize,z_threshold:zThr,
      bars_analyzed:data.length,current_price:closes[closes.length-1],
      last_log_return:lastZ?.lr??null,last_zscore:lastZ?.z??null,
      anomalies_hi:anomHi.length,anomalies_lo:anomLo.length,
      trigger,trigger_detail,recent_anomalies:allAnom.slice(0,10),
      last_updated:data[data.length-1].date});
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── /api/forecast ────────────────────────────────────────────────────────────
app.get('/api/forecast',requireAuth,async(req,res)=>{
  const{ticker,horizon='5',simulations='500'}=req.query;
  if(!ticker||!validTicker(ticker)) return res.status(400).json({error:'ticker required'});
  try{
    const H=Math.min(parseInt(horizon)||5,30),SIM=Math.min(parseInt(simulations)||500,2000);
    const data=await fetchYahoo(ticker,'1y','1d');
    if(data.length<30) return res.status(422).json({error:'Insufficient data'});
    const closes=data.map(d=>d.close),rets=logRet(closes);
    const{condVol,alpha,beta}=garch11(rets);
    const lastPrice=closes[closes.length-1];
    const paths=[];
    for(let s=0;s<SIM;s++){
      let price=lastPrice,vol=condVol;
      for(let h=0;h<H;h++){
        const r=(Math.random()<0.5?1:-1)*Math.sqrt(-2*Math.log(Math.random()))*vol;
        price*=Math.exp(r);vol=Math.sqrt(0.000001+alpha*r*r+beta*vol*vol);
      }
      paths.push(price);
    }
    paths.sort((a,b)=>a-b);
    const pct=p=>paths[Math.floor(p/100*SIM)];
    const annualVol=condVol*Math.sqrt(252);
    const condition=annualVol<0.15?'LOW_VOLATILITY':annualVol<0.35?'NORMAL_VOLATILITY':'HIGH_VOLATILITY';
    res.json({ticker,horizon:H,simulations:SIM,current_price:lastPrice,
      garch:{conditional_vol:condVol,annual_vol:annualVol,alpha,beta,ab_sum:alpha+beta},
      condition,
      percentiles:{p5:pct(5),p10:pct(10),p25:pct(25),p50:pct(50),p75:pct(75),p90:pct(90),p95:pct(95)},
      expected_range:{low:pct(25),high:pct(75)},
      last_updated:data[data.length-1].date});
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── /api/risk ────────────────────────────────────────────────────────────────
app.get('/api/risk',requireAuth,async(req,res)=>{
  const{ticker,capital='10000',risk_pct='1',sl_pips='10',rr='2',conviction='alta',fractal_range='1d'}=req.query;
  if(!ticker||!validTicker(ticker)) return res.status(400).json({error:'ticker required'});
  try{
    const cap=parseFloat(capital),pct=parseFloat(risk_pct),sl=parseFloat(sl_pips),rrV=parseFloat(rr);
    const convMult=conviction==='alta'?1:conviction==='media'?0.6:0.3;
    const frInterval=fractal_range==='1d'?'5m':fractal_range==='5d'?'1h':'1d';
    const[frData,yaData]=await Promise.all([fetchYahoo(ticker,fractal_range,frInterval),fetchYahoo(ticker,'5d','5m')]);
    const frC=frData.map(d=>d.close),frX=frC.map((_,i)=>i);
    const{pred,r2,stdRes}=linReg(frX,frC);
    const last=frC[frC.length-1],lastPred=pred[pred.length-1];
    let macroBias,macroDetail;
    if(last<lastPred-stdRes){macroBias='ALCISTA';macroDetail=`Bajo −1σ en ${fractal_range.toUpperCase()}`;}
    else if(last>lastPred+stdRes){macroBias='BAJISTA';macroDetail=`Sobre +1σ en ${fractal_range.toUpperCase()}`;}
    else{macroBias='NEUTRAL';macroDetail='Dentro de bandas normales';}
    const yaC=yaData.map(d=>d.close),yaR=logRet(yaC);
    let trigger='NONE',triggerDetail='Sin anomalía reciente',lastZ=null;
    if(yaR.length>20){
      const lr=yaR[yaR.length-1],ws=yaR.slice(-21,-1),m=mean(ws),s=std(ws)||1e-10,z=(lr-m)/s;
      lastZ=z;
      if(z<-2){trigger='LONG_TRIGGER';triggerDetail=`↓ LO z=${z.toFixed(2)}`;}
      if(z>2){trigger='SHORT_TRIGGER';triggerDetail=`↑ HI z=+${z.toFixed(2)}`;}
    }
    const aligned=macroBias!=='NEUTRAL'&&trigger!=='NONE'&&
      ((macroBias==='ALCISTA'&&trigger==='LONG_TRIGGER')||(macroBias==='BAJISTA'&&trigger==='SHORT_TRIGGER'));
    const direction=aligned?(trigger==='LONG_TRIGGER'?'LONG':'SHORT'):'NO_TRADE';
    const condMult=r2>0.7?1:r2>0.4?0.8:0.5;
    const effPct=pct*convMult*condMult,riskUSD=cap*effPct/100,pipSz=last>100?0.01:0.0001;
    res.json({ticker,direction,confluence:aligned?'2/2':'0/2',
      macro:{bias:macroBias,detail:macroDetail,r2},
      anomaly:{trigger,detail:triggerDetail,last_zscore:lastZ},
      inputs:{capital:cap,risk_pct:pct,sl_pips:sl,rr:rrV,conviction},
      multipliers:{conviction:convMult,condition:condMult},
      sizing:{effective_risk_pct:effPct,risk_usd:riskUSD,profit_usd:riskUSD*rrV,
              size_lots:riskUSD/(sl*10),size_units:Math.round(riskUSD/sl),tp_pips:sl*rrV},
      take_profits:{
        tp1:{long:+(last+sl*pipSz).toFixed(4),short:+(last-sl*pipSz).toFixed(4)},
        tp2:{long:+(last+sl*2*pipSz).toFixed(4),short:+(last-sl*2*pipSz).toFixed(4)},
        tp3:{long:+(last+sl*3*pipSz).toFixed(4),short:+(last-sl*3*pipSz).toFixed(4)},
      }});
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── /api/portfolio ───────────────────────────────────────────────────────────
app.get('/api/portfolio',requireAuth,async(req,res)=>{
  const{tickers}=req.query;
  if(!tickers) return res.status(400).json({error:'tickers required (comma separated)'});
  const list=tickers.split(',').map(t=>t.trim().toUpperCase()).filter(t=>validTicker(t)).slice(0,20);
  const results=await Promise.allSettled(list.map(async ticker=>{
    const[d5,d20]=await Promise.all([fetchYahoo(ticker,'5d','1d'),fetchYahoo(ticker,'1mo','1d')]);
    if(!d5.length) throw new Error('No data');
    const c5=d5.map(d=>d.close),c20=d20.map(d=>d.close);
    const last=c5[c5.length-1],prev1=c5.length>1?c5[c5.length-2]:last,prev5=c5[0]||last;
    const vol=c20.length>1?(std(logRet(c20))*Math.sqrt(252)*100).toFixed(2):null;
    const trs=d5.slice(1).map((d,i)=>Math.abs(d.close-d5[i].close));
    const atr=trs.length>0?(mean(trs.slice(-14))||mean(trs)).toFixed(3):null;
    const{slope}=linReg(c5.map((_,i)=>i),c5);
    return{ticker,price:last,delta_1d:+((last-prev1)/prev1*100).toFixed(2),
           delta_5d:+((last-prev5)/prev5*100).toFixed(2),
           vol_20d:vol?parseFloat(vol):null,atr14:atr?parseFloat(atr):null,
           signal:slope>0.001?'ALCISTA':slope<-0.001?'BAJISTA':'NEUTRAL'};
  }));
  res.json({tickers:list,count:list.length,
    portfolio:results.map((r,i)=>r.status==='fulfilled'?r.value:{ticker:list[i],error:r.reason.message})});
});

// ─── /api/snapshot ────────────────────────────────────────────────────────────
app.get('/api/snapshot',requireAuth,async(req,res)=>{
  const{ticker,capital='10000',risk_pct='1',sl_pips='10',rr='2',conviction='alta'}=req.query;
  if(!ticker||!validTicker(ticker)) return res.status(400).json({error:'ticker required'});
  try{
    const[frData,yaData]=await Promise.all([fetchYahoo(ticker,'1d','5m'),fetchYahoo(ticker,'5d','5m')]);
    const frC=frData.map(d=>d.close),frX=frC.map((_,i)=>i);
    const{pred,r2,stdRes}=linReg(frX,frC);
    const last=frC[frC.length-1],lastPred=pred[pred.length-1];
    const fs=last<lastPred-stdRes?'LONG_BIAS':last>lastPred+stdRes?'SHORT_BIAS':'NEUTRAL';
    const yaC=yaData.map(d=>d.close),yaR=logRet(yaC);
    let at='NONE',lz=null;
    if(yaR.length>20){const lr=yaR[yaR.length-1],ws=yaR.slice(-21,-1),m=mean(ws),s=std(ws)||1e-10,z=(lr-m)/s;lz=z;if(z<-2)at='LONG_TRIGGER';if(z>2)at='SHORT_TRIGGER';}
    const aligned=fs!=='NEUTRAL'&&at!=='NONE'&&((fs==='LONG_BIAS'&&at==='LONG_TRIGGER')||(fs==='SHORT_BIAS'&&at==='SHORT_TRIGGER'));
    const direction=aligned?(at==='LONG_TRIGGER'?'LONG':'SHORT'):'NO_TRADE';
    const cap=parseFloat(capital),pct=parseFloat(risk_pct),sl=parseFloat(sl_pips),rrV=parseFloat(rr);
    const convMult=conviction==='alta'?1:conviction==='media'?0.6:0.3;
    const condMult=r2>0.7?1:r2>0.4?0.8:0.5;
    const effPct=pct*convMult*condMult,riskUSD=cap*effPct/100;
    res.json({ticker,timestamp:new Date().toISOString(),current_price:last,
      fractal:{signal:fs,r2,sigma:stdRes,trend:lastPred},
      anomaly:{trigger:at,last_zscore:lz},
      direction,confluence:aligned?'2/2':'0/2',
      position:{size_lots:+(riskUSD/(sl*10)).toFixed(2),size_units:Math.round(riskUSD/sl),
                risk_usd:+riskUSD.toFixed(2),profit_usd:+(riskUSD*rrV).toFixed(2),effective_risk_pct:+effPct.toFixed(3)}});
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── /api/technicals — Alpha Vantage RSI + MACD + BBands ─────────────────────
// Fetches three AV indicators sequentially (rate-limit safe), cached 90 min.
// Free tier quota: 25 req/day → cache aggressively.
async function fetchAV(fn, symbol, extra={}) {
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key) throw new Error('ALPHA_VANTAGE_KEY not configured');
  const params = new URLSearchParams({ function: fn, symbol, apikey: key, datatype: 'json', ...extra });
  const r = await fetch(`https://www.alphavantage.co/query?${params}`,
    { headers: { 'User-Agent': 'ARKAQuantRelay/3.0' } });
  if (!r.ok) throw new Error(`AV HTTP ${r.status}`);
  const d = await r.json();
  if (d['Note'] || d['Information']) throw new Error('AV rate limit reached');
  return d;
}

// Extract latest N points from AV time series (RSI, MACD, BBands share the same structure)
function avSeries(obj, keys, n=60) {
  return Object.entries(obj)
    .sort((a,b)=>new Date(a[0])-new Date(b[0]))
    .slice(-n)
    .map(([date, vals]) => ({ date, ...Object.fromEntries(keys.map(k=>[k,parseFloat(vals[k])])) }));
}

app.get('/api/technicals', requireAuth, async (req, res) => {
  const { ticker, interval='daily' } = req.query;
  if (!ticker||!validTicker(ticker)) return res.status(400).json({ error:'ticker required' });
  const ck = `tech_${ticker.toUpperCase()}_${interval}`;
  const cached = getCached(ck);
  if (cached) return res.json(cached);
  try {
    const sym = ticker.toUpperCase();

    // ── RSI(14) ──────────────────────────────────────────────
    const rsiRaw = await fetchAV('RSI', sym, { interval, time_period:'14', series_type:'close' });
    await new Promise(r=>setTimeout(r, 700));

    // ── MACD(12,26,9) ─────────────────────────────────────────
    const macdRaw = await fetchAV('MACD', sym, { interval, series_type:'close', fastperiod:'12', slowperiod:'26', signalperiod:'9' });
    await new Promise(r=>setTimeout(r, 700));

    // ── BBands(20,2) ──────────────────────────────────────────
    const bbRaw = await fetchAV('BBANDS', sym, { interval, time_period:'20', series_type:'close', nbdevup:'2', nbdevdn:'2' });

    // ── Process RSI ───────────────────────────────────────────
    const rsiData = rsiRaw['Technical Analysis: RSI'] || {};
    const rsiSeries = avSeries(rsiData, ['RSI']);
    const rsiLatest = rsiSeries[rsiSeries.length-1]?.RSI ?? null;
    const rsiSignal = rsiLatest == null ? 'N/A' : rsiLatest >= 70 ? 'OVERBOUGHT' : rsiLatest <= 30 ? 'OVERSOLD' : 'NEUTRAL';

    // ── Process MACD ──────────────────────────────────────────
    const macdData = macdRaw['Technical Analysis: MACD'] || {};
    const macdSeries = avSeries(macdData, ['MACD','MACD_Signal','MACD_Hist']);
    const macdLast = macdSeries[macdSeries.length-1] || {};
    const macdTrend = (macdLast.MACD_Hist ?? 0) >= 0 ? 'BULLISH' : 'BEARISH';
    const macdCross = (() => {
      if (macdSeries.length < 2) return 'N/A';
      const prev = macdSeries[macdSeries.length-2];
      if (prev.MACD_Hist < 0 && macdLast.MACD_Hist >= 0) return 'BULLISH_CROSS';
      if (prev.MACD_Hist >= 0 && macdLast.MACD_Hist < 0) return 'BEARISH_CROSS';
      return 'N/A';
    })();

    // ── Process BBands ────────────────────────────────────────
    const bbData = bbRaw['Technical Analysis: BBANDS'] || {};
    const bbSeries = avSeries(bbData, ['Real Upper Band','Real Middle Band','Real Lower Band']);
    const bbLast = bbSeries[bbSeries.length-1] || {};
    // Get current price from RSI metadata or BBands middle
    const bbMiddle = bbLast['Real Middle Band'] ?? null;
    const bbUpper  = bbLast['Real Upper Band'] ?? null;
    const bbLower  = bbLast['Real Lower Band'] ?? null;

    const result = {
      ticker: sym,
      interval,
      lastUpdated: new Date().toISOString(),
      rsi: {
        current: rsiLatest,
        signal:  rsiSignal,
        series:  rsiSeries.map(d=>({ date:d.date, value:d.RSI })),
      },
      macd: {
        macd:      macdLast.MACD       ?? null,
        signal:    macdLast.MACD_Signal ?? null,
        histogram: macdLast.MACD_Hist   ?? null,
        trend:     macdTrend,
        cross:     macdCross,
        series:    macdSeries.map(d=>({ date:d.date, macd:d.MACD, signal:d.MACD_Signal, hist:d.MACD_Hist })),
      },
      bbands: {
        upper:     bbUpper,
        middle:    bbMiddle,
        lower:     bbLower,
        bandwidth: (bbUpper != null && bbLower != null && bbMiddle) ? ((bbUpper-bbLower)/bbMiddle*100) : null,
        series:    bbSeries.map(d=>({ date:d.date, upper:d['Real Upper Band'], middle:d['Real Middle Band'], lower:d['Real Lower Band'] })),
      },
    };

    setCached(ck, result, 90*60*1000); // 90 min — preserva quota free plan
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`ARKA Quant Relay v4.0 on :${PORT} | Auth:${process.env.ARKA_API_KEY?'ON':'UNCONFIGURED'}`);
});

// ─── /api/chat ────────────────────────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { system, messages, max_tokens } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  // Clamp max_tokens, sanitizar mensajes (igual que main relay /ai)
  const safeTokens = Math.min(Math.max(parseInt(max_tokens) || 1024, 50), 2000);
  const safeMessages = messages.slice(0, 20).map(m => ({
    role: ['user','assistant'].includes(m.role) ? m.role : 'user',
    content: String(m.content || '').slice(0, 8000),
  }));
  const safeSystem = system ? String(system).slice(0, 2000) : 'Eres el asistente de trading de ARKA.';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:safeTokens, system:safeSystem, messages:safeMessages })
    });
    if (!r.ok) { const err=await r.json(); return res.status(r.status).json({ error:err.error?.message||`Anthropic HTTP ${r.status}` }); }
    const data = await r.json();
    res.json({ content: data.content?.[0]?.text || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
