import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/db/pool',()=>({pool:{query:vi.fn()}}));
import {pool} from '../src/db/pool';
import {candidates,reportedReferenceHint,retrieveReferences,conservativeSuggestion} from '../src/services/referenceEvidence';
describe('technician markings used only for reference retrieval',()=>{
 it('maps the reported Cal_Royal 441 name to the catalog model',async()=>{
  const stage={component_class:'DOOR_CLOSER',manufacturer:null,model:null,confidence:{model:0}};
  const attrs={visible_markings:'Cal_Royal 441',component_type:'lockset',mounting_scope:'opening'};
  expect(candidates(stage,attrs)).toEqual(['cr441']);
  vi.mocked(pool.query).mockResolvedValueOnce({rows:[]} as never);
  await retrieveReferences(stage,attrs);
  expect(vi.mocked(pool.query).mock.calls.at(-1)?.[1]).toEqual([['cr441'],'Cal Royal 441 lockset opening','calroyal']);
  expect(conservativeSuggestion(stage,null).model).toBeNull();
  expect(stage.manufacturer).toBeNull();
 });
 it('requires a matching brand and bounded model token',()=>{
  for(const visible_markings of ['441','LCN 441','Cal-Royal 4410','Cal-Royal CR441UNSUPPORTED'])expect(reportedReferenceHint({visible_markings})).toBeNull();
  expect(reportedReferenceHint({visible_markings:'Cal-Royal CR441'})).toEqual({manufacturer:'Cal-Royal',model:'CR441'});
 });
 it('normalizes LCN lookup spellings without merging the two models',()=>{
  expect(candidates({}, {visible_markings:'LCN 4040 XP'})).toEqual(['4040xp']);
  expect(candidates({}, {visible_markings:'LCN 4041DA'})).toEqual(['4041 da']);
 });
 it('does not use a reported hint to fall back from an unsupported explicit model',()=>{
  expect(candidates({model:'CR441-UNSUPPORTED'}, {visible_markings:'Cal-Royal 441'})).toEqual(['cr441-unsupported']);
 });
});
