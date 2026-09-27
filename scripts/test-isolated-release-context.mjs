import assert from 'node:assert/strict';
import {assertIsolatedReleaseContext} from './isolated-release-context.mjs';
const good={NETLIFY:'true',SITE_ID:'80fbbee8-b9d3-4b16-b93f-d2d8396591ec',CONTEXT:'production',BRANCH:'release/connected-candidate'};
assert.doesNotThrow(()=>assertIsolatedReleaseContext(good));
for(const patch of [{NETLIFY:'false'},{SITE_ID:'ac07bb56-42f2-42b6-bcaf-0e543e99cac5'},{SITE_ID:'6430c57d-8a98-43bc-ba25-94007dd244f2'},{CONTEXT:'deploy-preview'},{BRANCH:'main'}]) assert.throws(()=>assertIsolatedReleaseContext({...good,...patch}));
console.log('Isolated release guard: approved context passed, all five forbidden contexts rejected.');
