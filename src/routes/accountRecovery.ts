import { Router } from 'express';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool';
export const accountRecoveryRouter = Router();
const input = z.object({
 email: z.string().trim().toLowerCase().email(),
 code: z.string().trim().regex(/^[a-f0-9]{64}$/),
 password: z.string().min(12).max(72).refine(p=>Buffer.byteLength(p,'utf8')<=72),
});
// Read-only readiness probe. It returns no account, code, or credential data.
accountRecoveryRouter.get('/status',async(_req,res)=>{
 res.setHeader('Cache-Control','no-store');
 let client;
 try{
  client=await pool.connect();
  await client.query('SELECT user_id FROM public.account_recovery_tokens WHERE false');
  await client.query('SELECT id,session_version FROM public.users WHERE false');
  return res.json({status:'available'});
 }catch(error){
  const code=String((error as {code?:string})?.code||'unknown');
  console.error('OI recovery readiness',{code:/^[A-Z0-9_]{1,40}$/.test(code)?code:'unknown'});
  return res.status(503).json({status:'unavailable'});
 }finally{client?.release();}
});
// Deliberately limited to explicitly authorized private validation sites. No public
// issuance endpoint: an authorized operator issues a code out of band.
accountRecoveryRouter.post('/confirm',async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 // Mounted only when the trusted Netlify request context enables recovery.
 const parsed=input.safeParse(req.body);
 if(!parsed.success)return res.status(400).json({error:'invalid_recovery_request'});
 let client;
 try{client=await pool.connect();}catch{return res.status(503).json({error:'recovery_unavailable'});}
 try{
  await client.query('BEGIN');
  const hash=createHash('sha256').update(parsed.data.code).digest('hex');
  const candidate=await client.query('SELECT user_id FROM public.account_recovery_tokens WHERE token_hash=$1',[hash]);
  if(!candidate.rows.length){await client.query('ROLLBACK');return res.status(400).json({error:'invalid_or_expired_code'});}
  // Lock user before token, serializing all reset codes for the same account.
  const user=await client.query('SELECT id,email,is_active FROM public.users WHERE id=$1 FOR UPDATE',[candidate.rows[0].user_id]);
  const token=await client.query('SELECT user_id FROM public.account_recovery_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',[hash]);
  if(!token.rows.length||!user.rows[0]?.is_active||user.rows[0].email!==parsed.data.email){
   await client.query('ROLLBACK');return res.status(400).json({error:'invalid_or_expired_code'});
  }
  const passwordHash=await bcrypt.hash(parsed.data.password,12);
  await client.query('UPDATE public.users SET password_hash=$1,session_version=session_version+1 WHERE id=$2',[passwordHash,user.rows[0].id]);
  await client.query('UPDATE public.account_recovery_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[user.rows[0].id]);
  await client.query('COMMIT');
  return res.json({message:'Password saved. Sign in with the password you just chose.'});
 }catch(error){
  const code=String((error as {code?:string})?.code||'unknown');
  console.error('OI recovery failure',{code:/^[A-Z0-9_]{1,40}$/.test(code)?code:'unknown'});
  await client.query('ROLLBACK').catch(()=>{});
  return res.status(503).json({error:'recovery_unavailable'});
 }finally{client.release();}
});
