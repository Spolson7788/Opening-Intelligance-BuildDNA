import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterFacilities,loadAuthorizedFacilities,defaultHomeState} from '../site/facility-search.mjs';
const rows=[{id:'a',name:'West',state:'CA',city:'Los Angeles',postal_code:'90001'},{id:'b',name:'East',state:'FL',city:'Miami'},{id:'c',name:'Unknown'}];
test('state and text narrow authorized rows, all-state preserves them, missing geography remains searchable',()=>{
 assert.deepEqual(filterFacilities(rows,{state:'ca'}).map(r=>r.id),['a']);
 assert.deepEqual(filterFacilities(rows,{query:'90001'}).map(r=>r.id),['a']);
 assert.deepEqual(filterFacilities(rows,{state:'CA',query:'Miami'}),[]);
 assert.equal(filterFacilities(rows).length,3);
 assert.deepEqual(filterFacilities(rows,{query:'Unknown'}).map(r=>r.id),['c']);
});
test('facility loading paginates beyond server limit and fails closed on errors',async()=>{
 let ranges=[];const sb={from:()=>({select:()=>({order:()=>({range:async(a,b)=>{ranges.push([a,b]);return {data:a===0?Array.from({length:500},(_,i)=>({id:String(i),name:'Facility'})):[{id:'last',name:'Last'}]};}})})})};
 assert.equal((await loadAuthorizedFacilities(sb)).length,501);assert.deepEqual(ranges,[[0,499],[500,999]]);
 const bad={from:()=>({select:()=>({order:()=>({range:async()=>({error:{message:'denied'}})})})})};
 await assert.rejects(loadAuthorizedFacilities(bad),/denied/);
});
test('a single approved home state defaults locally; conflicting assignments require explicit choice',async()=>{
 const sb=data=>({from:()=>({select:async()=>({data})})});
 assert.equal(await defaultHomeState(sb([{home_state:'CA'}])),'CA');
 assert.equal(await defaultHomeState(sb([{home_state:'CA'},{home_state:'FL'}])),'');
});
