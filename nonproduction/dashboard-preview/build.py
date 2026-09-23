from pathlib import Path
import re, json, hashlib, shutil
root=Path(__file__).parent
source=(root/'source/portal-base.html').read_text()
config=(root/'site/preview-config.mjs').read_text()
assert 'lujfnhvkmllnpxkihhno' in config
source=re.sub(r'const SUPA_URL=.*?;',"const SUPA_URL=url;",source)
source=re.sub(r'const SUPA_KEY=.*?;',"const SUPA_KEY=key;",source)
source=source.replace("@supabase/supabase-js@2'","@supabase/supabase-js@2.57.4'")
source=source.replace('<script type="module">','<script type="module">\nimport {url,key} from "./preview-config.mjs";\nimport {loadDashboardRows} from "./connected.mjs";')
old="await sb.from('openings').select('*').eq('facility_id',fac.id).order('opening_no',{ascending:true})"
assert old in source
source=source.replace(old,'await loadDashboardRows(sb,fac.id)')
old="sb.from('opening_photos').select('storage_path').eq('facility_id',current.id).eq('opening_no',o.opening_no).order('created_at',{ascending:true})"
assert old in source
source=source.replace(old,"sb.from('assembly_photos').select('storage_path,structure_id,component_id').eq('facility_id',current.id).eq('assembly_id',o.parts[0].assembly_id).order('taken_at',{ascending:true})")
source=source.replace("redirectTo:location.origin+'/'","redirectTo:location.origin+'/opening.html'")
source=source.replace('./index.html','./opening.html').replace('href="index.html"','href="opening.html"').replace('href="/"','href="opening.html"')
# Label preview prominently, without changing the recovered dashboard's layout.
source=source.replace('<body>','<body><aside style="background:#fff1c8;padding:12px;text-align:center">Nonproduction preview — connected acceptance pending. <a href="opening.html">Opening review</a></aside>')
# Show hierarchy explicitly in each component label.
source=source.replace("esc((p.component_class||'').replace(/_/g,' '))", "esc((p.component_class||'').replace(/_/g,' '))+'<small style=\"display:block\">'+esc((p.hierarchy||'opening').replace(/_/g,' '))+'</small>'")
source=source.replace("'all '+fireN+' current'", "'inspection dates recorded for '+fireN")
assert 'ytqiulxtiharrplqnuir' not in source
(root/'site/portal.html').write_text(source)
(root/'site/index.html').write_text('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=portal.html"><a href="portal.html">Facility Dashboard</a>')
(root/'site/portal-check.mjs').write_text(source.split('<script type="module">',1)[1].split('</script>',1)[0])
checks={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((root/'site').glob('*')) if p.is_file() and p.name not in ('SHA256SUMS.json','portal-check.mjs')}
(root/'site/SHA256SUMS.json').write_text(json.dumps(checks,indent=2))
print('Built preview-only portal and opening editor. '+str(len(checks))+' files hashed.')
