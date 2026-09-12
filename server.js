import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY = 12 * 1024 * 1024;

const schema = {
  type: 'object',
  properties: {
    signal: { type: 'string', enum: ['UP','DOWN','STOP'] },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    reason: { type: 'string' },
    risk: { type: 'string', enum: ['LOW','MEDIUM','HIGH'] }
  },
  required: ['signal','confidence','reason','risk'],
  additionalProperties: false
};

function headers(extra={}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    ...extra
  };
}
function send(res,status,data){res.writeHead(status,headers());res.end(JSON.stringify(data));}
function readBody(req){return new Promise((resolve,reject)=>{let size=0,chunks=[];req.on('data',c=>{size+=c.length;if(size>MAX_BODY){req.destroy();reject(new Error('Request too large. Use a smaller chart image.'));return}chunks.push(c)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(new Error('Invalid JSON request.'))}});req.on('error',reject)})}
function extractOutputText(j){if(typeof j?.output_text==='string')return j.output_text;let out='';for(const item of (j?.output||[])){for(const c of (item?.content||[])){if(typeof c?.text==='string')out+=c.text}}return out}
function normalizeResult(raw){let s=String(raw||'').trim();const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)s=s.slice(a,b+1);let j;try{j=JSON.parse(s)}catch{throw new Error('OpenAI returned unreadable JSON.')}const signal=String(j.signal||'STOP').toUpperCase();const confidence=Math.max(0,Math.min(100,Number(j.confidence)||0));const risk=String(j.risk||'HIGH').toUpperCase();if(!['UP','DOWN','STOP'].includes(signal)||!['LOW','MEDIUM','HIGH'].includes(risk))throw new Error('OpenAI returned invalid analysis fields.');return {signal,confidence,reason:String(j.reason||'No reason returned.'),risk};}
function prompt({market,timeframe,context}){return `You are the single technical chart-analysis engine for an educational trading tool. Analyze ONLY the supplied screenshot and the user's supplied fields. Do not claim certainty or guaranteed profit. Market/pair: ${market||'unknown'}. Candle timeframe: ${timeframe||'unknown'}. Extra context: ${context||'none'}. Inspect only visible evidence: trend/market structure, recent candle body and wick, momentum, support/resistance, breakout/rejection, and whether the next candle direction has sufficiently strong evidence. Do NOT invent hidden candles, live prices, indicators, news, or data not visible in the screenshot. If the chart is blurry, cropped, contradictory, OTC pricing is uncertain, or loss risk is meaningful, choose STOP. Choose UP or DOWN only when the visible evidence supports a reasonably strong next-candle hypothesis. Return ONLY the JSON schema requested by the API.`}
async function callOpenAI({image,market,timeframe,context}){
  if(!OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is not configured on Render.');
  if(typeof image!=='string'||!image.startsWith('data:image/'))throw new Error('Chart image is missing or invalid.');
  const body={model:OPENAI_MODEL,input:[{role:'user',content:[{type:'input_text',text:prompt({market,timeframe,context})},{type:'input_image',image_url:image,detail:'high'}]}],text:{format:{type:'json_schema',name:'trading_signal',strict:true,schema}},max_output_tokens:500,store:false};
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}`},body:JSON.stringify(body)});
  const t=await r.text();let j={};try{j=JSON.parse(t)}catch{}
  if(!r.ok)throw new Error(`OpenAI ${r.status}: ${j?.error?.message||t.slice(0,300)||'request failed'}`);
  return normalizeResult(extractOutputText(j));
}
async function callFuture({image,prompt}){
  if(!OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is not configured on Render.');
  const body={model:OPENAI_MODEL,input:[{role:'user',content:[{type:'input_text',text:`${prompt}\nReturn ONLY valid JSON.`},{type:'input_image',image_url:image,detail:'high'}]}],text:{format:{type:'json_object'}},max_output_tokens:700,store:false};
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}`},body:JSON.stringify(body)});
  const t=await r.text();let j={};try{j=JSON.parse(t)}catch{}if(!r.ok)throw new Error(`OpenAI ${r.status}: ${j?.error?.message||t.slice(0,300)||'request failed'}`);let raw=extractOutputText(j);const a=raw.indexOf('{'),b=raw.lastIndexOf('}');if(a>=0&&b>a)raw=raw.slice(a,b+1);return JSON.parse(raw);
}
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,headers());return res.end();}
  const url=new URL(req.url,`http://${req.headers.host}`);
  if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{ok:true,service:'trading-strategy-vault-ai',model:OPENAI_MODEL});
  if(req.method!=='POST')return send(res,404,{error:'Not found'});
  try{const body=await readBody(req);if(url.pathname==='/api/analyze'){const result=await callOpenAI(body);return send(res,200,result)}if(url.pathname==='/api/future'){const result=await callFuture(body);return send(res,200,result)}return send(res,404,{error:'Unknown endpoint'});}catch(e){return send(res,500,{error:e.message||'Server error'})}
});
server.listen(PORT,()=>console.log(`AI backend listening on ${PORT}`));
