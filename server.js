const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const {OAuth2Client} = require('google-auth-library');

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'32kb'}));

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '506134860126-v75qmbti4m8b0l5ms7h96hhejlj2q1jm.apps.googleusercontent.com';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'anonimshakh4647@gmail.com').toLowerCase();
// SESSION_SECRET is generated automatically on first run and stored locally.
// You can still override it with the SESSION_SECRET environment variable on a real server.
const SECRET_FILE = path.join(__dirname, '.it-shakh-session-secret');
function loadOrCreateSessionSecret(){
  if(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32){
    return process.env.SESSION_SECRET;
  }
  try{
    if(fs.existsSync(SECRET_FILE)){
      const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if(saved.length >= 64) return saved;
    }
    const generated = crypto.randomBytes(64).toString('hex');
    fs.writeFileSync(SECRET_FILE, generated + '\n', {flag:'w', mode:0o600});
    console.log('Generated a private SESSION_SECRET automatically.');
    console.log('Secret file:', SECRET_FILE);
    return generated;
  }catch(err){
    console.error('ERROR: Could not create the private session secret file:', err.message);
    process.exit(1);
  }
}
const SESSION_SECRET = loadOrCreateSessionSecret();

const google = new OAuth2Client(CLIENT_ID);
const publicDir = __dirname;
const COOKIE = 'it_shakh_admin_session';
const MAX_AGE = 8 * 60 * 60; // 8 hours

function b64url(buf){ return Buffer.from(buf).toString('base64url'); }
function sign(data){ return b64url(crypto.createHmac('sha256', SESSION_SECRET).update(data).digest()); }
function makeSession(email){
  const payload = b64url(Buffer.from(JSON.stringify({email, exp: Math.floor(Date.now()/1000)+MAX_AGE})));
  return payload + '.' + sign(payload);
}
function readSession(req){
  const raw = (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));
  if(!raw) return null;
  const value = decodeURIComponent(raw.slice(COOKIE.length+1));
  const [payload, mac] = value.split('.');
  if(!payload || !mac) return null;
  const expected = sign(payload);
  if(mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try{
    const data = JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if(!data.email || data.email.toLowerCase() !== ADMIN_EMAIL) return null;
    if(!data.exp || data.exp < Math.floor(Date.now()/1000)) return null;
    return data;
  }catch{return null;}
}
function isHttps(req){
  return req.secure === true || req.headers['x-forwarded-proto'] === 'https';
}
function setSession(req,res,email){
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeSession(email))}; Max-Age=${MAX_AGE}; Path=/; HttpOnly${secure}; SameSite=Lax`);
}
function clearSession(req,res){
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly${secure}; SameSite=Lax`);
}
function requireAdmin(req,res,next){
  if(!readSession(req)) return res.status(403).send('Access denied');
  next();
}

app.post('/api/auth/google', async (req,res)=>{
  try{
    const credential = String(req.body?.credential || '');
    if(!credential) return res.status(400).json({ok:false,error:'Missing credential'});
    const ticket = await google.verifyIdToken({idToken:credential,audience:CLIENT_ID});
    const p = ticket.getPayload();
    if(!p?.email || p.email_verified !== true) return res.status(401).json({ok:false,error:'Google account not verified'});
    const email = p.email.toLowerCase();
    if(email === ADMIN_EMAIL) setSession(req,res,email); else clearSession(req,res);
    res.json({ok:true,admin:email===ADMIN_EMAIL});
  }catch(err){
    clearSession(req,res);
    res.status(401).json({ok:false,error:'Invalid Google credential'});
  }
});

app.get('/api/admin/me',(req,res)=>{
  const s=readSession(req);
  if(!s) return res.status(403).json({ok:false});
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true,email:s.email});
});

app.post('/api/logout',(req,res)=>{clearSession(req,res);res.json({ok:true});});

// IMPORTANT: admin.html is NOT exposed by express.static. It is served only after server authorization.
app.get('/admin.html', requireAdmin, (req,res)=>res.sendFile(path.join(publicDir,'admin.html')));

app.use(express.static(publicDir, {
  index:'index.html',
  dotfiles:'deny',
  setHeaders(res,file){
    if(path.basename(file)==='admin.html') res.status(404);
  }
}));

app.listen(PORT,()=>console.log(`IT SHAKH secure server listening on http://localhost:${PORT}`));
