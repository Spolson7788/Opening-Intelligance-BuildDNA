import entries from './pdqCatalog.json';
import {catalogTranscription} from './catalogMarking';
import type {LabelEvidence,LabelRead} from './labelReading';

export type IdentityCatalogEntry={manufacturer:string;series:string|null;model:string;component_class:string|null;device_type?:string;display_name:string;[key:string]:any};
const typeClasses:Record<string,string>={exit_device:'EXIT_DEVICE',panic_bar:'EXIT_DEVICE',closer:'DOOR_CLOSER',lockset:'LOCKSET',hinge:'HINGE_BUTT',electric_strike:'ELECTRIC_STRIKE',power_transfer:'POWER_TRANSFER'};
// A catalog constrains photo evidence; missing coverage is never proof of incompatibility.
export function catalogIdentityReview(labels:LabelEvidence,classifier:Record<string,any>={},technician:Record<string,string>={},catalog:IdentityCatalogEntry[]|null=entries) {
 const excluded=labels.reads.filter(r=>(labels.version==='oi-targeted-label-reading-3'&&!r.provenance)||r.provenance&&(r.provenance.source==='context'||r.provenance.target_device!==true||!r.provenance.location_validated||r.provenance.source==='focused_view'&&(r.provenance.verification_scope!=='supplied_view'||r.provenance.marking_complete!==true||!Number.isInteger(r.provenance.view_index)||r.provenance.view_index!<0||r.provenance.view_index!>3)));
 const usable=labels.reads.filter(r=>!excluded.includes(r)&&r.vision_status==='read'&&!r.ocr_model_conflicts?.length);
 const marks=usable.filter(r=>r.region.kind==='brand_mark'&&!r.vision_text.includes('?'));
 const evidence=(r:LabelRead,kind:string)=>({photo_index:r.region.photo_index,kind,text:r.vision_text,region:r.region,provenance:r.provenance??{source:'legacy_unverified'}});
 const candidates=(catalog||[]).flatMap(entry=>{
  const models=usable.filter(r=>r.region.kind!=='brand_mark'&&catalogTranscription(r.vision_text,entry.model));
  const logos=marks.filter(r=>catalogTranscription(r.vision_text,entry.manufacturer));
  if(!models.length||!logos.length)return [];
  return [{...entry,series_basis:entry.series?'catalog_row':null,verification:'pending_technician' as const,evidence:[...models.map(r=>evidence(r,'model')),...logos.map(r=>evidence(r,'brand_mark'))]}];
 });
 const supportedModels=(catalog||[]).filter(e=>usable.some(r=>r.region.kind!=='brand_mark'&&catalogTranscription(r.vision_text,e.model)));
 const otherMarks=marks.filter(r=>candidates.length&&!candidates.some(e=>catalogTranscription(r.vision_text,e.manufacturer)));
 const conflict=(candidates.length>0&&otherMarks.length>0)||(supportedModels.length>0&&marks.length>0&&!candidates.length);
 const selectedClass=technician.component_type_source==='technician'?typeClasses[technician.component_type]??null:null;
 const classes=[...new Set(candidates.map(c=>c.component_class).filter(Boolean))];
 const typeConflict=classes.length===1&&((classifier.component_class&&classifier.component_class!==classes[0])||(selectedClass&&selectedClass!==classes[0]))||Boolean(selectedClass&&classifier.component_class&&selectedClass!==classifier.component_class);
 const readableModel=usable.some(r=>r.region.kind!=='brand_mark'&&/\bMODEL\s*[:#-]?\s*[A-Z0-9]*\d[A-Z0-9-]*/i.test(r.vision_text));
 const status=catalog===null?'CATALOG_UNAVAILABLE':conflict?'CONFLICT':typeConflict?'TYPE_CONFLICT':candidates.length?'CANDIDATES':marks.length&&readableModel?'UNSUPPORTED_BY_CATALOG':'INSUFFICIENT_EVIDENCE';
 return {status,candidates,excluded_evidence:excluded.map(r=>({...evidence(r,'excluded'),reason:r.provenance?.association_status==='invalid'?'invalid_device_association':r.provenance?.target_device===false?'other_device':'unvalidated_location'})),
  maker_evidence:marks.map(r=>evidence(r,'brand_mark')),model_evidence:usable.filter(r=>r.region.kind!=='brand_mark').map(r=>evidence(r,'model')),
  type_evidence:{technician_class:selectedClass,classifier_class:classifier.component_class??null,catalog_classes:classes},
  classifier_claim:{manufacturer:classifier.manufacturer??null,model:classifier.model??null,source:'classifier_only'},
  classifier_disagreement:candidates.length>0&&Boolean(classifier.manufacturer&&!candidates.some(c=>catalogTranscription(classifier.manufacturer,c.manufacturer))),
  catalog_scope:'Reviewed identity rows; incomplete catalog',limitation:'Photo-supported proposal; technician acknowledgment and catalog-update review remain separate.'};
}
export function applyCatalogIdentityProposal(suggestion:Record<string,any>,review:ReturnType<typeof catalogIdentityReview>){
 if(!['CANDIDATES','TYPE_CONFLICT'].includes(review.status)||review.candidates.length!==1)return suggestion;
 const candidate=review.candidates[0];
 return {...suggestion,manufacturer:candidate.manufacturer,series:candidate.series,model:candidate.model,
  component_class:candidate.component_class||suggestion.component_class||null,classifier_component_class:suggestion.component_class??null,
  confidence:{...suggestion.confidence,manufacturer:null,series:null,model:null},
  identity_status:review.status==='TYPE_CONFLICT'?'type_conflict':'pending_technician',series_basis:candidate.series?'catalog_row':null,identity_basis:'readable_maker_and_exact_catalog_model',
  identity_evidence:candidate.evidence,catalog_identity_review:review};
}
