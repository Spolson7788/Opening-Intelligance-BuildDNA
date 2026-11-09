import {useState} from 'react';
import type {FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {recoveryResponse} from '../lib/authResponse';
export function AccountRecoveryPage(){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[done,setDone]=useState(false);
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();const element=e.currentTarget;const form=new FormData(element);
  const password=String(form.get('password')||'');
  if(password!==form.get('confirmation')){setMessage('The two passwords do not match.');return;}
  if(new TextEncoder().encode(password).length>72){setMessage('Choose a password of at most 72 UTF-8 bytes.');return;}
  setBusy(true);setMessage('');
  try{
   const response=await fetch(`${import.meta.env.VITE_API_BASE_URL||'/api'}/account-recovery/confirm`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:String(form.get('email')||'').trim(),code:String(form.get('code')||'').trim(),password})});
   const result=await recoveryResponse(response);
   if(result.saved){element.reset();setDone(true);}
   setMessage(result.message);
  }catch{setMessage('Could not confirm the reset. Check your connection before trying again.');}
  finally{setBusy(false);}
 }
 return <div className="app-shell c04"><div className="screen"><p className="c04-kicker">Field app</p><h1>Recover test account</h1><section className="c04-band-green"><p className="c04-note">Use the single-use code supplied by your administrator. Choose your own password below.</p></section>
 {!done&&<form className="c04-band" onSubmit={submit}>
 <div className="field"><label htmlFor="recovery-email">Email</label><input id="recovery-email" name="email" type="email" autoComplete="username" required/></div>
 <div className="field"><label htmlFor="recovery-code">Recovery code</label><input id="recovery-code" name="code" type="password" autoComplete="off" required/></div>
 <div className="field"><label htmlFor="new-password">New password</label><input id="new-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required/></div>
 <div className="field"><label htmlFor="confirm-password">Confirm new password</label><input id="confirm-password" name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={72} required/></div>
 <p>Use at least 12 characters.</p><button className="btn btn-primary" type="submit" disabled={busy}>{busy?'Saving…':'Save new password'}</button></form>}
 {message&&<p className={done?undefined:'c04-alert'} role={done?'status':'alert'}>{message}</p>}<Link to="/login">Return to sign in</Link></div></div>;
}
