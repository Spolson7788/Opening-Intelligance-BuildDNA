import {displayPhotoReferences} from '../lib/labelReadStatus';
type PhotoEvidence={photo_index:number;kind:string;text:string;region?:{x:number;y:number;w:number;h:number};provenance?:{source:string;rotation?:number;location_validated?:boolean}};
type CatalogCandidate={manufacturer:string;series:string|null;model:string;source_url:string;page:number;display_name?:string;component_class?:string;evidence:PhotoEvidence[]};
export interface CatalogReview {
 status:string;
 candidates:CatalogCandidate[];
 partial_identity?:{manufacturer:string;series:string|null;model:null;source_url?:string|null;evidence:PhotoEvidence[]}|null;
 reader_disagreements?:string[];
 maker_evidence:{photo_index:number;text:string}[];
 model_evidence?:PhotoEvidence[];
 excluded_evidence?:(PhotoEvidence&{reason:string})[];
 type_evidence?:{technician_class:string|null;classifier_class:string|null;catalog_classes:(string|null)[]};
 classifier_disagreement?:boolean;
 classifier_claim?:{manufacturer:string|null;model:string|null};
}

export function CatalogIdentityEvidence({review,files=[],identified=false}:{review:CatalogReview;files?:{name:string}[];identified?:boolean}) {
 const photo=(index:number)=>`Photo ${index+1}${files[index]?.name?` (${files[index].name})`:''}`;
 const conflict=['CONFLICT','TYPE_CONFLICT'].includes(review.status);
 const stateMessages:Record<string,string>={PARTIAL_IDENTITY:'The readable maker and series are retained. The exact model and installed configuration are unresolved.',TYPE_CONFLICT:'Component types disagree. The catalog identity proposal is retained; verify the target device before recording it.',UNSUPPORTED_BY_CATALOG:'The maker and model were read, but this catalog does not yet cover that pair.',CATALOG_UNAVAILABLE:'The catalog could not be checked. Photo readings are retained.'};
 return <section aria-label="Identity evidence across photographs">
  <h3>Identity evidence across photographs</h3>
  <p role={conflict?'alert':'status'}>{(review.status==='PARTIAL_IDENTITY'&&!review.partial_identity?.series?'The readable maker is retained. Series, exact model and installed configuration are unresolved.':stateMessages[review.status])|| (conflict?'Conflicting evidence: the readable maker markings disagree with each other or with the catalog model association. Verify the installed device before choosing an identity.':identified?'Identified from the maker mark and exact model marking in these photographs.':review.status==='CANDIDATES'?'Catalog-supported candidate — review the evidence.':'Not enough evidence to establish a catalog-supported brand and model pair.')}</p>
  {review.partial_identity&&!conflict&&<div>
   <p><strong>{review.partial_identity.manufacturer}{review.partial_identity.series?` ${review.partial_identity.series} series`:''}</strong> — exact model unresolved.</p>
   <ul>{review.partial_identity.evidence.map((e,i)=><li key={i}>{photo(e.photo_index)} — {e.kind==='series'?'series marking':'maker mark'}: “{e.text}”</li>)}</ul>
   {review.partial_identity.source_url&&<p><a href={review.partial_identity.source_url} target="_blank" rel="noopener noreferrer">Manufacturer family reference</a></p>}
  </div>}
  {!!review.reader_disagreements?.length&&<div role="alert"><p>Photo-set concerns reported by the AI reader — verify these before recording the device:</p><ul>{review.reader_disagreements.map((message,i)=><li key={i}>{displayPhotoReferences(message)}</li>)}</ul></div>}
  {review.candidates.map(candidate=><div key={`${candidate.manufacturer}-${candidate.model}`}>
   <p><strong>{identified?`${candidate.manufacturer} Model ${candidate.model} ${candidate.display_name||'hardware'}`:`${candidate.manufacturer} / ${candidate.series} / ${candidate.model}`}</strong></p>
   {identified&&<p>{candidate.series?`Series ${candidate.series}. `:'Series not established. '}Record review: awaiting technician acknowledgment.</p>}
   <ul>{candidate.evidence.map((e,i)=><li key={i}>{photo(e.photo_index)} — {e.kind==='brand_mark'?'maker mark':'model marking'}: “{e.text}”{e.provenance&&` — ${e.provenance.source}; rotation ${e.provenance.rotation||0}°`}{e.region&&` — source box x=${e.region.x.toFixed(3)}, y=${e.region.y.toFixed(3)}, w=${e.region.w.toFixed(3)}, h=${e.region.h.toFixed(3)}`}</li>)}</ul>
   <p><a href={candidate.source_url||undefined} target="_blank" rel="noopener noreferrer">Manufacturer reference</a>, PDF page {candidate.page}. Catalog information supports the model designation; the photo readings still need your verification.</p>
  </div>)}
  {review.status==='TYPE_CONFLICT'&&review.type_evidence&&<p role="alert">Technician: {review.type_evidence.technician_class||'no deliberate choice'}; photo classifier: {review.type_evidence.classifier_class||'unclassified'}; catalog: {review.type_evidence.catalog_classes.join(', ')||'type unspecified'}. Confirm the actual device type below.</p>}
  {review.classifier_disagreement&&<p role="alert">The classifier's maker estimate disagrees with the located maker/model evidence and was not used as the identity.</p>}
  {!!review.excluded_evidence?.length&&<details><summary>Excluded readings</summary><ul>{review.excluded_evidence.map((e,i)=><li key={i}>{photo(e.photo_index)} — “{e.text}”: {e.reason.replace(/_/g,' ')}. Excluded from identity and conflict checks.</li>)}</ul></details>}
  {review.status==='UNSUPPORTED_BY_CATALOG'&&<ul>{review.model_evidence?.map((e,i)=><li key={i}>{photo(e.photo_index)} — model transcription “{e.text}”; catalog match unavailable.</li>)}</ul>}
  {!!review.maker_evidence.length&&<details><summary>Maker markings read from these photographs</summary><ul>{review.maker_evidence.map((e,i)=><li key={i}>{photo(e.photo_index)} — “{e.text}”</li>)}</ul></details>}
  {review.classifier_claim?.manufacturer&&<details><summary>Initial photograph estimate</summary><p>{review.classifier_claim.manufacturer} {review.classifier_claim.model||''} — an AI estimate, not a verified maker marking. Review the photo evidence above.</p></details>}
  <p>These photographs were submitted for one component. Only markings located on the target device may establish its identity. Technician acknowledgment records your acceptance or correction; purchasing follows the opening review workflow.</p>
 </section>;
}
