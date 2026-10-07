#!/usr/bin/env python3
"""Create missing page assets locally. Reuse explicitly mapped existing renders."""
import argparse, hashlib, json, subprocess, shutil
from pathlib import Path

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--manifest',type=Path,required=True);p.add_argument('--corpus',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--existing-map',type=Path,required=True)
    a=p.parse_args()
    # Mapping: [{doc_sha256,page_no,path,sha256}]. Empty [] is valid only when
    # there are no existing renders for the selected corpus. Never guess joins.
    existing=json.loads(a.existing_map.read_text());mapped={(x['doc_sha256'],x['page_no']):x for x in existing}
    docs=[json.loads(s) for s in (a.manifest/'reference_manifest.jsonl').read_text().splitlines()]
    assets=[]
    for d in docs:
        pdf=a.corpus/d['path'];assert digest(pdf)==d['sha256']
        directory=a.output/d['sha256'];directory.mkdir(parents=True,exist_ok=True)
        for n in range(1,d['page_count']+1):
            target=directory/f'p{n:03d}.png';source=mapped.get((d['sha256'],n))
            if source:
                src=Path(source['path']);assert digest(src)==source['sha256']
                if not target.exists():shutil.copyfile(src,target)
                assert digest(target)==source['sha256']
            elif not target.exists():
                subprocess.run(['pdftoppm','-f',str(n),'-l',str(n),'-r','110','-png','-singlefile',str(pdf),str(target.with_suffix(''))],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            assert target.read_bytes()[:8]==b'\x89PNG\r\n\x1a\n'
            assets.append({'doc_sha256':d['sha256'],'page_no':n,'path':str(target),'sha256':digest(target),'reused_existing':bool(source)})
    (a.output/'page_assets.json').write_text(json.dumps(assets,sort_keys=True,indent=2)+'\n')
    print(json.dumps({'pages':len(assets),'reused_existing':len(existing)}))
if __name__=='__main__':main()
