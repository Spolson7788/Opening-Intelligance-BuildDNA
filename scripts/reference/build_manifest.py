#!/usr/bin/env python3
"""Deterministic conversion of the completed audit; never re-extracts or calls models."""
import argparse, csv, hashlib, json, re
from pathlib import Path

VERSION = 'oi-reference-1'
EXTRACTOR = {'name': 'poppler-pdftotext-layout-audit', 'version': 'existing-audit-20261002'}
def sha(data): return hashlib.sha256(data).hexdigest()
def rows(path): return list(csv.DictReader(path.open(encoding='utf-8-sig')))
def write_jsonl(path, values):
    path.write_text(''.join(json.dumps(v,sort_keys=True,ensure_ascii=False)+'\n' for v in values),encoding='utf-8')

def build(audit, output, corpus=None):
    docs=rows(audit/'02_manifests/doc_manifest.csv')
    revisions={r['doc_sha256']:r for r in rows(audit/'02_manifests/revision_tracking.csv')}
    classes={(r['doc_sha256'],int(r['page'])):r['class'] for r in rows(audit/'03_page_analysis/page_classifications_lt100chars.csv')}
    fractions={(r['doc_sha256'],int(r['page'])) for r in rows(audit/'03_page_analysis/fraction_affected_pages.csv')}
    comparisons={(r['doc_sha256'],int(r['page'])):r for r in rows(audit/'03_page_analysis/page_text_comparison.csv')}
    output.mkdir(parents=True,exist_ok=True)
    by_path={d['doc_path']:d['sha256'] for d in docs}
    page_rows=[]; texts={}; queue=[]
    class_map={'blank/near-blank':'blank','mixed small images + vector':'mixed','photo/cover page (image-dominant)':'photo','scanned raster page (needs OCR)':'scan','vector drawing/template (text as outlines or strokes; render+vision)':'drawing'}
    for p in rows(audit/'02_manifests/page_manifest.csv'):
        key=(p['doc_sha256'],int(p['page']))
        name=Path(p['doc_path']).with_suffix('').as_posix()+'.p'+f"{key[1]:03d}"+'.txt'
        data=(audit/'04_correction_evidence/page_text'/name).read_bytes()
        assert sha(data)==p['page_text_sha256(pdftotext -layout -f N -l N)'],name
        text=data.decode('utf-8'); texts.setdefault(key[0],[]).append((key[1],text))
        kind=class_map.get(classes.get(key),'text')
        mismatch=comparisons[key]; a=int(mismatch['our_nonws']); b=int(mismatch['cat_nonws'])
        different=abs(a-b)/max(a,b,1)>.1
        reasons=[]
        if kind in ('scan','drawing','mixed'): reasons.append('visual_transcription')
        if different: reasons.append('extractor_disagreement')
        if key in fractions: reasons.append('fraction_unverified')
        if reasons: queue.append({'doc_sha256':key[0],'page':key[1],'reasons':';'.join(reasons)})
        page_rows.append(dict(manifest_version=VERSION,extractor=EXTRACTOR,doc_sha256=key[0],page_no=key[1],page_id=f'sha256:{key[0]}#p{key[1]}',text=text,text_sha256=sha(data),page_class=kind,citable=kind=='text' and not reasons,transcription_status='queued' if reasons else 'none',fraction_unverified=key in fractions,image_key=f'reference/Allegion/{key[0]}/p{key[1]:03d}.png'))
    # Candidate vocabulary is only a discovery aid; every retained entry must
    # occur in document text and remains subject to separate human approval.
    vocabulary=set()
    for d in docs:
        vocabulary.update(re.findall(r'(?<!\w)(?:\d{4}[A-Z]{0,3}|\d{2}[A-Z]?|PS\d{3}|KR\d{2,4}|QEL|EPT)(?!\w)',Path(d['doc_path']).parts[1].upper()))
    vocabulary.update(['1250','1450','1450DA','4050A','4050A DEL','4040XP','4041 DA','4600','4800','8310-806K','9530IQ','9550IQ','9560IQ','KR54','KR1654','KR4954','2800','9500','33A','35A','94','95','98','99'])
    results=[]; conflicts=[]
    for d in docs:
        h=d['sha256']; path=d['doc_path']; rev=revisions[h]
        if corpus is not None:
            assert sha((corpus/path).read_bytes())==h,path
        models=[]
        for token in sorted(vocabulary):
            pattern=re.compile(r'(?<![A-Z0-9])'+re.escape(token).replace(r'\ ',r'\s*')+r'(?![A-Z0-9])',re.I)
            for n,text in texts[h]:
                match=pattern.search(text)
                if match and len(token)<=3 and token.isdigit():
                    context=text[max(0,match.start()-35):match.end()+35]
                    if not re.search(r'series|device|rim|\b'+re.escape(token)+r'[/&-]\d|\d[/&-]'+re.escape(token)+r'\b',context,re.I): match=None
                if match:
                    quote=text[max(0,match.start()-60):match.end()+80].strip()
                    models.append(dict(series=None,model=token,variant=None,evidence_page=n,evidence_quote=quote)); break
        # Corrections explicitly verified in the completed review.
        if '419_flush_adapter' in path: models=[m for m in models if m['model'] in ('1250','1450')]
        if '4630-4640' in path and 'data_sheet' in path: models=[m for m in models if m['model'] in ('4600','4800')]
        if 'remote_key_switch' in path: models=[m for m in models if m['model']=='8310-806K']
        status='draft'; duplicate=None; superseded=None
        if 'EPT' in path and 'wood' in path.lower():
            targets=[x for x in docs if 'EPT' in x['doc_path'] and 'metal' in x['doc_path'].lower()]
            if len(targets)==1: status='duplicate'; duplicate=targets[0]['sha256']; models=[]
        if '_4040SEC.pdf' in path:
            targets=[x for x in docs if x['doc_path']=='LCN/4040SE/LCN_4040SE_installation_instructions.pdf']
            if len(targets)==1: status='superseded'; superseded=targets[0]['sha256']
        folder=Path(path).parts[1]
        results.append(dict(manifest_version=VERSION,extractor=EXTRACTOR,sha256=h,path=path,bytes=int(d['bytes']),page_count=int(d['pages']),manufacturer='Allegion',brand='Schlage' if '/PS900/' in path else Path(path).parts[0].replace('VonDuprin','Von Duprin'),title=Path(path).stem.replace('_',' '),doc_type='installation' if 'installation' in path else 'template' if 'template' in path else 'catalog' if 'catalog' in path else 'product_data',allegion_web_doc_no=rev['web_doc_no(filename)'] or None,instruction_or_template_no=rev['instruction_no_p1'] or None,revision=rev['revision_strings'] or None,copyright_year=rev['copyright_years'] or None,source_url=d['source_url'],source_note=rev['source_note'],retrieved_at=None,upstream_etag_or_last_modified=None,source_archive=Path(path).parts[0]+'.zip',status=status,superseded_by=superseded,duplicate_of=duplicate,folder_family=folder,folder_family_provenance='folder-derived; not product-validated',coverage_status='text-evidenced candidates; requires document approval',models=models,unverified_models=[{'model':m,'reason':'folder-derived discovery token absent from verified text'} for m in sorted(vocabulary) if m in folder and m not in {x['model'] for x in models}]))
        if path=='LCN/1260/LCN_1260_cut_sheet.pdf':
            t=texts[h][0][1]
            quote=re.search(r'The 1260 is adjustable\s+for spring sizes 1-5\.',t).group()
            conflicts.append({'doc_sha256':h,'field':'spring_size','values':[{'value':'1-5','page':1,'quote':quote},{'value':'1-6','page':1,'quote':'Adjustable spring size 1-6'}]})
    if corpus:
        archive_hashes={}
        for d in results:
            archive=corpus.parent/d['source_archive']
            if archive.exists():
                if archive not in archive_hashes: archive_hashes[archive]=sha(archive.read_bytes())
                d['source_archive_sha256']=archive_hashes[archive]
    write_jsonl(output/'reference_manifest.jsonl',results)
    write_jsonl(output/'reference_pages.jsonl',page_rows)
    write_jsonl(output/'conflicts.jsonl',conflicts)
    (output/'corpus_identity.json').write_text(json.dumps({'manifest_version':VERSION,'documents':[{ 'sha256':d['sha256'],'page_count':d['page_count'],'bytes':d['bytes'],'path':d['path']} for d in results],'source_doc_manifest_sha256':sha((audit/'02_manifests/doc_manifest.csv').read_bytes()),'expected_documents':248,'expected_pages':1952},sort_keys=True,indent=2)+'\n')
    (output/'audit_doc_manifest.csv').write_bytes((audit/'02_manifests/doc_manifest.csv').read_bytes())
    with (output/'transcription_queue.csv').open('w') as f:
        w=csv.DictWriter(f,fieldnames=['doc_sha256','page','reasons']); w.writeheader(); w.writerows(queue)
    (output/'fraction_mapping.json').write_text(json.dumps({'verified':{'Z\\x':'½','C\\v':'¾'},'policy':'Keep affected pages non-citable until every used mapping is verified against the original page.'},indent=2))
    return results,page_rows

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--audit',type=Path,required=True); p.add_argument('--output',type=Path,required=True); p.add_argument('--corpus',type=Path)
    a=p.parse_args(); d,pages=build(a.audit,a.output,a.corpus); print(json.dumps({'documents':len(d),'pages':len(pages),'approved':0}))
