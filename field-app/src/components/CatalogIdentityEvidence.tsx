type PhotoEvidence={photo_index:number;kind:string;text:string};
type CatalogCandidate={manufacturer:string;series:string;model:string;source_url:string;page:number;evidence:PhotoEvidence[]};
export interface CatalogReview {
 status:string;
 candidates:CatalogCandidate[];
 maker_evidence:{photo_index:number;text:string}[];
 classifier_claim?:{manufacturer:string|null;model:string|null};
}

export function CatalogIdentityEvidence({review,files=[],identified=false}:{review:CatalogReview;files?:{name:string}[];identified?:boolean}) {
 const photo=(index:number)=>`Photo ${index+1}${files[index]?.name?` (${files[index].name})`:''}`;
 const conflict=review.status==='CONFLICT';
 return <section aria-label="Identity evidence across photographs">
  <h3>Identity evidence across photographs</h3>
  <p role={conflict?'alert':'status'}>{conflict?'Conflicting evidence: the readable maker markings disagree with each other or with the catalog model association. Verify the installed device before choosing an identity.':identified?'Identified from the maker mark and exact model marking in these photographs.':review.status==='CANDIDATES'?'Catalog-supported candidate — review the evidence.':'Not enough evidence to establish a catalog-supported brand and model pair.'}</p>
  {review.candidates.map(candidate=><div key={`${candidate.manufacturer}-${candidate.model}`}>
   <p><strong>{identified?`${candidate.manufacturer} Model ${candidate.model} rim exit device`:`${candidate.manufacturer} / ${candidate.series} / ${candidate.model}`}</strong></p>
   {identified&&<p>Series {candidate.series}. Record review: awaiting technician acknowledgment.</p>}
   <ul>{candidate.evidence.map((e,i)=><li key={i}>{photo(e.photo_index)} — {e.kind==='brand_mark'?'maker mark':'model marking'}: “{e.text}”</li>)}</ul>
   <p><a href={candidate.source_url} target="_blank" rel="noopener noreferrer">Manufacturer reference</a>, PDF page {candidate.page}. Catalog information supports the model designation; the photo readings still need your verification.</p>
  </div>)}
  {!!review.maker_evidence.length&&<details><summary>Maker markings read from these photographs</summary><ul>{review.maker_evidence.map((e,i)=><li key={i}>{photo(e.photo_index)} — “{e.text}”</li>)}</ul></details>}
  {review.classifier_claim?.manufacturer&&<details><summary>Initial photograph estimate</summary><p>{review.classifier_claim.manufacturer} {review.classifier_claim.model||''} — an AI estimate, not a verified maker marking. Review the photo evidence above.</p></details>}
  <p>All photographs in this submission describe one component. Technician acknowledgment records your acceptance or correction; purchasing follows the opening review workflow.</p>
 </section>;
}
