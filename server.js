const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!GOOGLE_CLIENT_ID || !SESSION_SECRET || !DATABASE_URL) {
  console.error('Missing GOOGLE_CLIENT_ID, SESSION_SECRET or DATABASE_URL');
  process.exit(1);
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

async function initDb(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      google_sub TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      picture TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS quiz_results (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score INTEGER NOT NULL CHECK (score >= 0),
      total INTEGER NOT NULL CHECK (total > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS quiz_results_user_idx ON quiz_results(user_id);
    CREATE INDEX IF NOT EXISTS quiz_results_score_idx ON quiz_results(score DESC);
  `);
}

function auth(req,res,next){
  const h=req.headers.authorization||'';
  const token=h.startsWith('Bearer ')?h.slice(7):'';
  if(!token) return res.status(401).json({error:'Unauthorized'});
  try{ req.session=jwt.verify(token,SESSION_SECRET); next(); }
  catch(e){ return res.status(401).json({error:'Invalid session'}); }
}

app.post('/api/auth/google', async (req,res)=>{
  try{
    const { credential }=req.body||{};
    if(!credential) return res.status(400).json({error:'Missing credential'});
    const ticket=await googleClient.verifyIdToken({idToken:credential,audience:GOOGLE_CLIENT_ID});
    const p=ticket.getPayload();
    if(!p || !p.sub || !p.email) return res.status(401).json({error:'Invalid Google account'});
    const result=await pool.query(`
      INSERT INTO users(google_sub,name,email,picture) VALUES($1,$2,$3,$4)
      ON CONFLICT(google_sub) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,picture=EXCLUDED.picture,updated_at=NOW()
      RETURNING id,name,email,picture
    `,[p.sub,p.name||p.email,p.email,p.picture||null]);
    const u=result.rows[0];
    const token=jwt.sign({userId:u.id,name:u.name,email:u.email},SESSION_SECRET,{expiresIn:'7d'});
    res.json({token,user:{name:u.name,email:u.email,picture:u.picture||''}});
  }catch(e){ console.error(e); res.status(401).json({error:'Google verification failed'}); }
});

app.get('/api/leaderboard', async (req,res)=>{
  try{
    const sort=req.query.sort==='name'?'name':'score';
    const order=sort==='name'?'u.name ASC':'best_score DESC, best_percent DESC, best_at ASC';
    const rows=await pool.query(`
      SELECT u.name,u.picture,MAX(r.score)::int AS best_score,
             ROUND(MAX((r.score::numeric/r.total::numeric)*100),0)::int AS best_percent,
             COUNT(r.id)::int AS attempts,
             MIN(r.created_at) AS first_at,
             MIN(r.created_at) FILTER (WHERE r.score=(SELECT MAX(r2.score) FROM quiz_results r2 WHERE r2.user_id=u.id)) AS best_at
      FROM users u JOIN quiz_results r ON r.user_id=u.id
      GROUP BY u.id,u.name,u.picture
      ORDER BY ${order}
      LIMIT 100
    `);
    const stats=await pool.query(`
      SELECT COUNT(DISTINCT user_id)::int AS total_users,
             COALESCE(MAX(score),0)::int AS best_score,
             COALESCE(MIN(score),0)::int AS lowest_score
      FROM quiz_results
    `);
    res.json({rows:rows.rows,stats:stats.rows[0]});
  }catch(e){ console.error(e); res.status(500).json({error:'Leaderboard failed'}); }
});

app.post('/api/quiz/results',auth,async(req,res)=>{
  try{
    const score=Number(req.body?.score), total=Number(req.body?.total);
    if(!Number.isInteger(score)||!Number.isInteger(total)||score<0||total<=0||score>total) return res.status(400).json({error:'Invalid result'});
    await pool.query('INSERT INTO quiz_results(user_id,score,total) VALUES($1,$2,$3)',[req.session.userId,score,total]);
    res.json({ok:true});
  }catch(e){ console.error(e); res.status(500).json({error:'Save failed'}); }
});

app.get('/api/me',auth,async(req,res)=>{
  const r=await pool.query('SELECT id,name,email,picture FROM users WHERE id=$1',[req.session.userId]);
  res.json(r.rows[0]||null);
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));

initDb().then(()=>app.listen(PORT,()=>console.log(`IT SHAKH server running on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
