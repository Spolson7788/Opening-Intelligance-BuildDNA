import entries from './pdqCatalog.json';
import {catalogTranscription} from './catalogMarking';
import type {LabelEvidence} from './labelReading';

// Catalog facts constrain a hypothesis; they never substitute for a photo read.
export function catalogIdentityReview(labels:LabelEvidence,classifier:Record<string,any>={}) {
 const usable=labels.reads.filter(r=>r.vision_status==='read'&&!r.vision_text.includes('?')&&!r.ocr_model_conflicts?.length);
 const marks=usable.filter(r=>r.region.kind==='brand_mark');
 const candidates=entries.flatMap(entry=>{
  const models=usable.filter(r=>r.region.kind!=='brand_mark'&&catalogTranscription(r.vision_text,entry.model));
  const logos=marks.filter(r=>catalogTranscription(r.vision_text,entry.manufacturer));
  if(!models.length||!logos.length)return [];
  return [{...entry,verification:'pending_technician' as const,evidence:[...models.map(r=>({photo_index:r.region.photo_index,kind:'model' as const,text:r.vision_text})),...logos.map(r=>({photo_index:r.region.photo_index,kind:'brand_mark' as const,text:r.vision_text}))]}];
 });
 const otherMarks=marks.filter(r=>!catalogTranscription(r.vision_text,'PDQ'));
 const hasSupportedModel=usable.some(r=>r.region.kind!=='brand_mark'&&entries.some(e=>catalogTranscription(r.vision_text,e.model)));
 const conflict=(candidates.length>0&&otherMarks.length>0)||(hasSupportedModel&&marks.length>0&&!candidates.length);
 return {status:conflict?'CONFLICT':candidates.length?'CANDIDATES':'INSUFFICIENT_EVIDENCE',candidates,
  maker_evidence:marks.map(r=>({photo_index:r.region.photo_index,text:r.vision_text})),
  classifier_claim:{manufacturer:classifier.manufacturer??null,model:classifier.model??null,source:'classifier_only'},
  catalog_scope:'PDQ legacy rim designations; incomplete catalog',
  limitation:'Candidate only. Technician acknowledgment is required; no identity is confirmed or learned by this review.'};
}

// This is a reviewable proposal, never a technician-confirmed identity. A
// classifier guess cannot overrule a clear maker mark plus exact catalog model.
export function applyCatalogIdentityProposal(suggestion:Record<string,any>,review:ReturnType<typeof catalogIdentityReview>){
 if(review.status!=='CANDIDATES'||review.candidates.length!==1||
    (suggestion.component_class&&suggestion.component_class!=='EXIT_DEVICE'))return suggestion;
 const candidate=review.candidates[0];
 return {...suggestion,manufacturer:candidate.manufacturer,series:candidate.series,model:candidate.model,
  confidence:{...suggestion.confidence,manufacturer:null,series:null,model:null},
  identity_status:'pending_technician',identity_basis:'readable_maker_and_exact_catalog_model',
  identity_evidence:candidate.evidence,catalog_identity_review:review};
}
