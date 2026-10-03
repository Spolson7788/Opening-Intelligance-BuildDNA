import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/db/pool',()=>({pool:{query:vi.fn()}}));
import {pool} from '../src/db/pool';
import {compareInstallationGeometry,approvedInstallationGeometry,geometrySources} from '../src/services/installationGeometry';
const corners=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
const holes=[{x:.1,y:.7},{x:.25,y:.7},{x:.7,y:.3},{x:.85,y:.3}];
const view={photo_index:0,mount:'pull_side',coplanar:true,face_corners:corners,mounting_holes:holes};
describe('installation geometry from independent visible landmarks',()=>{
 it('retains three lookalikes and never reports photo millimeters or a verified identity',()=>{
  const r=compareInstallationGeometry([view],1);
  expect(r.status).toBe('shared_pattern_compatible');expect(r.candidates.map(c=>c.model)).toEqual(['4040XP','4041 DA','CR441']);
  expect(r.absolute_photo_dimensions).toBeNull();expect(r.identity_verified).toBe(false);
  expect(r.observations[0].relative_intervals).toEqual([1,3,1]);
 });
 it('rectifies perspective using the independent face rather than fitting the holes',()=>{
  const project=(p:{x:number;y:number})=>({x:(.15+.65*p.x+.08*p.y)/(1+.22*p.x+.11*p.y),y:(.12+.04*p.x+.7*p.y)/(1+.22*p.x+.11*p.y)});
  const r=compareInstallationGeometry([{...view,face_corners:corners.map(project),mounting_holes:holes.map(project)}],1);
  expect(r.status).toBe('shared_pattern_compatible');expect(r.observations[0].max_relative_error).toBe(0);
 });
 it('supports mirrored handedness without choosing a different model',()=>{
  const mirror=(p:{x:number;y:number})=>({x:1-p.x,y:p.y});
  expect(compareInstallationGeometry([{...view,face_corners:corners.map(mirror),mounting_holes:holes.map(mirror)}],1).candidates).toHaveLength(3);
 });
 it('does not promote an arbitrary four-hole quadrilateral to a match',()=>{
  const r=compareInstallationGeometry([{...view,mounting_holes:[holes[0],holes[1],{x:.5,y:.3},holes[3]]}],1);
  expect(r.status).toBe('pattern_not_supported');expect(r.candidates).toEqual([]);
 });
 it.each([{mounting_holes:holes.slice(0,3)},{face_corners:[]},{coplanar:false},{mount:'unknown'},{photo_index:1},{face_corners:[corners[0],corners[2],corners[1],corners[3]]},{mounting_holes:[...holes.slice(0,3),{x:2,y:.3}]}])('abstains for unavailable or invalid landmarks: %j',change=>{
  expect(compareInstallationGeometry([{...view,...change}],1).status).toBe('insufficient_visible_landmarks');
 });
 it('does not filter out a photo based on pixel dimensions',()=>{
  expect(compareInstallationGeometry([{...view,image_width:165,image_height:220}],1).status).toBe('shared_pattern_compatible');
 });
 it('uses only approved hash-matched documents',async()=>{
  vi.mocked(pool.query).mockResolvedValueOnce({rows:[{sha256:geometrySources[1].doc_sha256}]} as any);
  expect((await approvedInstallationGeometry([view],1)).candidates.map(c=>c.model)).toEqual(['CR441']);
  vi.mocked(pool.query).mockResolvedValueOnce({rows:[]} as any);
  expect((await approvedInstallationGeometry([view],1)).status).toBe('reference_geometry_unavailable');
 });
});
