import {it,expect} from 'vitest';
import {mediaAssociationLabel} from '../field-app/src/lib/mediaAssociationLabel';
const opening={hardware_components:[{id:'a',component_type:'closer',model_number:'Same',door_leaf_id:'la',tracker_id:'A'},{id:'b',component_type:'closer',model_number:'Same',door_leaf_id:'lb',tracker_id:'B'}],door_leaves:[{id:'la',leaf_role:'active'},{id:'lb',leaf_role:'inactive'}]};
it('distinguishes identical hardware on separate leaves by stored identity',()=>{
 expect(mediaAssociationLabel({related_entity_type:'hardware_component',related_entity_id:'a'},opening)).toBe('Component: closer · Same · active leaf · A');
 expect(mediaAssociationLabel({related_entity_type:'hardware_component',related_entity_id:'b'},opening)).toBe('Component: closer · Same · inactive leaf · B');
});
it('does not silently label an unavailable component as an opening photo',()=>{
 expect(mediaAssociationLabel({related_entity_type:'hardware_component',related_entity_id:'missing'},opening)).toContain('associated component unavailable');
});
it('retains the same association for queued photographs',()=>{
 expect(mediaAssociationLabel({targetType:'hardware_component',targetId:'b'},opening)).toContain('inactive leaf · B');
});
