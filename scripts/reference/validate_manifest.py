import argparse, hashlib, json
from pathlib import Path

def load(path): return [json.loads(s) for s in path.read_text().splitlines() if s]
def validate(root, corpus=None):
    docs=load(root/'reference_manifest.jsonl'); pages=load(root/'reference_pages.jsonl')
    identity=json.loads((root/'corpus_identity.json').read_text())
    assert hashlib.sha256((root/'audit_doc_manifest.csv').read_bytes()).hexdigest()==identity['source_doc_manifest_sha256']
    assert len(docs)==identity['expected_documents'] and len(pages)==identity['expected_pages'],'Corpus count mismatch'
    by_hash={d['sha256']:d for d in docs}; assert len(by_hash)==len(docs)
    by_page={(p['doc_sha256'],p['page_no']):p for p in pages}; assert len(by_page)==len(pages)
    assert {d['sha256'] for d in identity['documents']}==set(by_hash),'Corpus document identity mismatch'
    for d in identity['documents']:
        assert all(by_hash[d['sha256']][k]==d[k] for k in ('page_count','bytes','path'))
    for d in docs:
        assert d['retrieved_at'] is None,'Unknown retrieval date must remain null'
        assert d['status'] in ('draft','duplicate','superseded'),'Builder never approves'
        assert d['source_archive_sha256'] and len(d['source_archive_sha256'])==64
        if corpus: assert hashlib.sha256((corpus/d['path']).read_bytes()).hexdigest()==d['sha256']
        for n in range(1,d['page_count']+1): assert (d['sha256'],n) in by_page
        for m in d['models']:
            p=by_page[(d['sha256'],m['evidence_page'])]
            assert m['evidence_quote'] and m['evidence_quote'] in p['text']
        if d['status']=='duplicate': assert d['duplicate_of'] in by_hash
        if d['status']=='superseded': assert d['superseded_by'] in by_hash
    for p in pages:
        assert p['page_id']==f"sha256:{p['doc_sha256']}#p{p['page_no']}"
        assert hashlib.sha256(p['text'].encode()).hexdigest()==p['text_sha256']
        if p['page_class']=='blank' or p['fraction_unverified']: assert not p['citable']
        if p['page_class'] in ('scan','drawing','mixed'): assert not p['citable'] or p['transcription_status']=='verified'
    for d in docs:
        models={m['model'] for m in d['models']}
        if '419_flush_adapter' in d['path']: assert models=={'1250','1450'}
        if '/4630-4640/' in d['path'] and 'data_sheet' in d['path']: assert models=={'4600','4800'}
        if 'remote_key_switch' in d['path']: assert models=={'8310-806K'}
        if '/PS900/' in d['path']: assert d['brand']=='Schlage'
        if '_4040SEC.pdf' in d['path']: assert d['status']=='superseded'
        if '/EPT/' in d['path'] and 'wood' in d['path']: assert d['status']=='duplicate'
        if '/4040XP/' in d['path'] and 'pull_side' in d['path']: assert {'4040XP','4041 DA'}<=models
    for c in load(root/'conflicts.jsonl'):
        assert len(c['values'])>1
        for v in c['values']: assert v['quote'] in by_page[(c['doc_sha256'],v['page'])]['text']
    return {'documents':len(docs),'pages':len(pages),'citable_pages':sum(p['citable'] for p in pages),'approved_documents':0}

if __name__=='__main__':
    a=argparse.ArgumentParser(); a.add_argument('root',type=Path); a.add_argument('--corpus',type=Path); r=a.parse_args()
    print(json.dumps(validate(r.root,r.corpus)))
