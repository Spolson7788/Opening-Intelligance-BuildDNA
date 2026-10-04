import {it,expect,vi} from 'vitest';
vi.mock('../src/db/pool',()=>({pool:{query:vi.fn().mockResolvedValue({rows:[]})}}));
import {pool} from '../src/db/pool';
import {candidates,reportedReferenceHint,retrieveReferences} from '../src/services/referenceEvidence';
it('keeps reported identity for display only without interpreting marking text',()=>{
 expect(reportedReferenceHint({manufacturer:'Norton',model:'7500'})).toEqual({manufacturer:'Norton',model:'7500'});
 expect(reportedReferenceHint({visible_markings:'LCN 4040XP'})).toBeNull();
});
it('retrieval is invariant to every technician attribute',async()=>{
 const stage={manufacturer:'Norton',model:'7500',visible_text:['Norton','7500']};
 for(const attributes of [{},{manufacturer:'LCN',model:'4040XP',visible_markings:'LCN 4040XP'},{manufacturer:'Cal-Royal',series:'CR441',notes:'Sargent'}]){
  expect(candidates(stage,attributes)).toEqual(['7500']);
  await retrieveReferences(stage,attributes);
 }
 const args=vi.mocked(pool.query).mock.calls.map(c=>c[1]);
 expect(args[0]).toEqual(args[1]);expect(args[1]).toEqual(args[2]);
 expect(candidates({}, {model:'4040XP'})).toEqual([]);
});
