import 'fake-indexeddb/auto';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {api} from '../facility-dashboard/api-client.mjs';
const a={userId:'a',organizationId:'org-a',token:'synthetic-a'};
async function save(session:any){await new Promise<void>((resolve,reject)=>{const r=indexedDB.open('opening-intel-field',1);r.onupgradeneeded=()=>r.result.createObjectStore('auth');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,t=db.transaction('auth','readwrite');t.objectStore('auth').put(session,'current');t.oncomplete=()=>{db.close();resolve();};};});}
beforeEach(async()=>{globalThis.indexedDB=new IDBFactory();await save(a);});
afterEach(()=>vi.unstubAllGlobals());
it('rejects private document bytes if account changes while the response body arrives',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>{await save({...a,userId:'b'});return {pdf_base64:'synthetic-private-bytes'};}})));
 await expect(api('/commercial/documents/version',undefined,a)).rejects.toThrow('Account changed');
});
it('rejects a stale screen principal before sending a write',async()=>{
 const send=vi.fn();vi.stubGlobal('fetch',send);await save({...a,organizationId:'org-b'});
 await expect(api('/commercial/catalog',{synthetic:true},a)).rejects.toThrow('Account changed');expect(send).not.toHaveBeenCalled();
});
