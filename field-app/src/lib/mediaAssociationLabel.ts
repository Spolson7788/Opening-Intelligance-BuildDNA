type Association = {related_entity_type?: string; related_entity_id?: string; targetType?: string; targetId?: string};
type Opening = {hardware_components?: Array<{id: string; component_type?: string; manufacturer?: string; model_number?: string; tracker_id?: string; door_leaf_id?: string}>; door_leaves?: Array<{id: string; leaf_role?: string}>};
/** Describe the stored association, never infer one from photo order or appearance. */
export function mediaAssociationLabel(photo: Association, opening: Opening): string {
 const type=photo.related_entity_type||photo.targetType||'opening';
 const id=photo.related_entity_id||photo.targetId;
 if(type==='hardware_component'){
  const component=opening.hardware_components?.find(c=>c.id===id);
  if(!component)return 'Component photograph — associated component unavailable';
  const leaf=opening.door_leaves?.find(l=>l.id===component.door_leaf_id);
  const identity=[component.component_type,component.manufacturer,component.model_number].filter(Boolean).join(' · ');
  return ['Component: '+(identity||'unidentified'),leaf?.leaf_role?leaf.leaf_role+' leaf':null,component.tracker_id].filter(Boolean).join(' · ');
 }
 if(type==='door_leaf'){
  const leaf=opening.door_leaves?.find(l=>l.id===id);
  return leaf?.leaf_role?'Door leaf: '+leaf.leaf_role:'Door leaf photograph — associated leaf unavailable';
 }
 if(type==='frame')return 'Frame photograph';
 if(type==='service_event')return 'Service event photograph';
 if(type==='inspection_event')return 'Inspection event photograph';
 return type==='opening'?'Opening photograph':'Photograph — association unavailable';
}
