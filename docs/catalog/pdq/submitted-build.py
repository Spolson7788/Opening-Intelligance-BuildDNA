import csv,re,os,sys
R='/workspace/pdq_docs/'
idx={r['filename']:r for r in csv.DictReader(open(R+'index.csv'))}
PB='PDQ/_catalogs/PDQ_catalogs_price_book_2026_Price_Book'
BR='PDQ/6300/PDQ_6300_brochure_6300_6400_brochure'
BR4='PDQ/6400/PDQ_6400_brochure_6300_6400_brochure'
B42='PDQ/4200/PDQ_4200_brochure_4200_series_brochure'
QX='PDQ/_shared/General/PDQ_shared_General_cross_reference_Quick_Cross_Reference_Guide'
SP='PDQ/_shared/ElectronicLocks/PDQ_shared_ElectronicLocks_brochure_spirit_brochure'
TR='PDQ/Exit_Trim_6/PDQ_Exit_Trim_6_cut_sheet_6300_6400_series_trims_architectural_submittal_sheet'
CS=lambda s,m:f'PDQ/{s}/PDQ_{s}_cut_sheet_{m}_series_architectural_submittal_sheet'
def cite(base,q):
    t=open(R+base+'.txt',encoding='utf-8',errors='replace').read()
    pat=r'\s+'.join(map(re.escape,q.split()))
    m=re.search(pat,t)
    if not m: sys.exit(f'QUOTE NOT FOUND: {base}: {q}')
    pdf=base+'.pdf'; r=idx[pdf]
    return dict(source_pdf='pdq_docs/'+pdf,source_url=r['source_url'],source_sha256=r['sha256'],page=t[:m.start()].count('\f')+1,quote=q)
M=[]
def add(series,model,dtype,status,sev,mark,base,q):
    M.append(dict(manufacturer='PDQ',series=series,model=model,device_type=dtype,status=status,status_evidence=sev,identifying_markings=mark,**cite(base,q)))
ul=lambda s:f'Not documented in library beyond model designation \"{s}\" in literature; {{}}'
cur='current'
# 6300 wide stile (2026 price book lines)
pb=[('6300','6300R','rim (wide stile)','6300R Rim, Listed to UL305 for Panic'),('6300','6300RF','rim, fire-rated (wide stile)','6300RF Rim, Listed to UL10C for Fire'),
('6300','6300V','surface vertical rod (wide stile)','6300V Surface vertical rod, Listed to UL305 for Panic'),('6300','6300VF','surface vertical rod, fire-rated (wide stile)','6300VF Surface vertical rod, Listed to UL10C for Fire'),
('6300','6300C','concealed vertical rod (wide stile)','6300C Concealed vertical rod, Listed to UL305 for Panic'),('6300','6300CF','concealed vertical rod, fire-rated (wide stile)','6300CF Concealed vertical rod, Listed to UL10C for Fire'),
('6300','6300M','mortise (wide stile)','6300M Mortise wide stile exit, Listed to UL305 for Panic'),('6300','6300MF','mortise, fire-rated (wide stile)','6300MF Mortise wide stile exit, Listed to UL10C for Fire'),
('6300','6300D','dummy (non-latching) device','6300D Dummy, 3’0” door'),
('6400','6400R','rim (narrow stile)','6400R Rim, Listed to UL305 for Panic'),('6400','6400RF','rim, fire-rated (narrow stile)','6400RF Rim, Listed to UL10C for Fire'),
('6400','6400V','surface vertical rod (narrow stile)','6400V Surface vertical rod, Listed to UL305 for Panic'),('6400','6400VF','surface vertical rod, fire-rated (narrow stile)','6400VF Surface vertical rod, Listed to UL10C for Fire'),
('6400','6400C','concealed vertical rod (narrow stile)','6400C Concealed Vertical Rod Narrow Stile Exit Devices'),('6400','6400CF','concealed vertical rod, fire-rated (narrow stile)','6400CF Concealed vertical rod, Listed to UL10C for Fire'),
('4200','4200R','rim (wide stile, ANSI type 1)','4200R Rim, UL panic listed, hex key dogging, 3’0” door'),('4200','4200RA','rim, 4\'0" door (wide stile)','4200RA Rim, UL panic listed, hex key dogging, 4’0” door'),
('4200','4200RF','rim, fire-rated (wide stile)','4200RF Rim, UL fire listed, no dogging, 3’0” door'),('4200','4200V','surface vertical rod (wide stile, ANSI type 2)','4200V Surface vertical rod, UL panic listed, hex key dogging, 3’0” door'),
('4200','4200VA','surface vertical rod, 4\'0" door','4200VA Surface vertical rod, UL panic listed, hex key dogging, 4’0” door'),('4200','4200VF','surface vertical rod, fire-rated','4200VF Surface vertical rod, UL fire listed, no dogging, 3’0” door')]
for s,m,d,q in pb:
    ul_txt='UL10C fire listing' if 'F' in m[4:] else ('UL panic listing' if s!='6300' or m!='6300D' else 'no UL listing stated')
    mk=f'Model designation "{m}" in PDQ literature; price book states {ul_txt}. Physical label/logo appearance NOT documented in library.'
    add(s,m,d,cur,'Listed with price in 2026 Price Book',mk,PB,q)
# 6200 previous generation
add('6200','6200','unknown (series-level; no device-type variants such as 6200R named in library)','discontinued',
 'PDQ calls 6200 the "previous generation" (2026 Price Book); word "discontinued" not used; no 6200 price/spec in library',
 'Not documented. Only indirect: 6300 TLA head cover is "Similar to 6200 Series" (appearance of 6200 head cover resembles TLA).',
 PB,'The TLA head cover can be ordered to make the 6300 device better match the previous generation 6200 devices.')
F=['manufacturer','series','model','device_type','status','status_evidence','identifying_markings','source_pdf','source_url','source_sha256','page','quote']
w=csv.DictWriter(open('pdq_exit_models.csv','w',newline=''),F);w.writeheader();w.writerows(M)
Rl=[]
def rel(s,r,o,base,q):
    c=cite(base,q);Rl.append(dict(subject=s,relation=r,object=o,identity_evidence='no',source_pdf=c['source_pdf'],source_url=c['source_url'],page=c['page'],quote=q))
rel('PDQ HG1 trim (6EWS option)','fits','Hager 4500 series exit device',PB,'HG1 6EWS Trim for Hager 4500 series / PDQ 6200 series')
rel('PDQ HG1 trim (6EWS option)','fits','PDQ 6200 series exit device',PB,'HG1 6EWS Trim for Hager 4500 series / PDQ 6200 series')
rel('PDQ DK1 trim (6EWS option)','fits','Dorma 9300 exit device',PB,'DK1 6EWS Trim adapted to fit existing Dorma 9300 device')
rel('PDQ 6S sectional trim (shipped after March 2022)','not_compatible','PDQ 6200 series exit devices',PB,'Note: 6S Trim shipped after March 2022 is not compatible with 6200 series exit devices. Contact factory for retrofit trim.')
rel('PDQ 6S sectional trim (shipped after March 2022)','not_compatible','PDQ 6200 series exit devices',TR,'Note: 6S Trim shipped after March 2022 is not compatible with 6200 series exit devices.')
rel('PDQ 6300 with TLA head cover','look_alike','PDQ 6200 series (previous generation)',PB,'The TLA head cover can be ordered to make the 6300 device better match the previous generation 6200 devices.')
rel('PDQ TLA head cover (6300/6400 option)','look_alike','PDQ 6200 series head cover',CS('6300','6300r'),'TLA Head Cover (Similar to 6200 Series)')
rel('PDQ 6300 series','replaces','PDQ 6200 series',PB,'better match the previous generation 6200 devices')
# QCRG
w63=['6300R','6300RF','6300V','6300VF','6300C','6300CF','6300M','6300MF']
x63={'CORBIN':'ED5200 ED5200A ED5400 ED5400A ED5860 ED5860B ED5600 ED5600A','DORMA':'9300 F9300 9400 F9400 9100 F9100 9500 F9500','FALCON':'25-R F-25-R 25-V F-25-V 25-C F-25-C 25-M F-25-M',
'SARGENT®':'8800 12-8800 8700 12-8700 8600 12-8600 8900 12-8900','VON DUPRIN':'98/99 98/99-F 98/9927 98/9927-F 98/9947 98/9947-F 98/9975 98/9975-F','ACCENTRA (FMR. YALE)':'7100 7100F 7110 7110F 7160 7160F 7130 7130F'}
hag63=['4501 RIM','4501 RIM FR','4501 SVR','4501 SVR FR','4500 CVR','4500 CVR FR','4500 MRT','4500 MRT']
w64=['6400R','6400RF','6400V','6400VF','6400C','6400CF']
x64={'CORBIN':'ED4200 ED4200MA ED4400 ED4400MA ED4800 ED4800MA','DORMA':'9700 F9700 9800 F9800 9600 F9600','FALCON':'24-R F-24-R 24-V F-24-V 24-C F-24-C',
'SARGENT®':'8500 12-8500 N/A N/A 8400 12-8400','VON DUPRIN':'33A/35A 33A/35A-F 3327A/3527A 3327A/3527A-F 3347A/3547A 3347A/3547A-F','ACCENTRA (FMR. YALE)':'7200 7200F 7210 7210F 7220 7220F'}
hag64=['4601 RIM','4601 RIM FR','4601 SVR','4601 SVR FR','4601 CVR','4601 CVR FR']
def emit(pdq,rows,hag):
    for mf,v in rows.items():
        q=f'{mf} '+v; vals=v.split()
        for p,o in zip(pdq,vals):
            if o!='N/A': rel(f'PDQ {p}','cross_reference',f'{mf.replace("®","")} {o}',QX,q)
    q='HAGER '+' '.join(hag)
    for p,o in zip(pdq,hag): rel(f'PDQ {p}','cross_reference',f'HAGER {o}',QX,q)
emit(w63,x63,hag63);emit(w64,x64,hag64)
q42r='RIM 4200R 2200 ED8200 8300 19 R 4700 Rim 5100 2828 UL520 8300 22 2100'
mf42=['CAL ROYAL','CORBIN/RUSSWIN','DORMA','FALCON','HAGER','PRECISION','SARGENT','S PARKER','TELL','VON DUPRIN','ACCENTRA (FMR. YALE)']
for mf,o in zip(mf42,['2200','ED8200','8300','19 R','4700 Rim','5100','2828','UL520','8300','22','2100']): rel('PDQ 4200R','cross_reference',f'{mf} {o}',QX,q42r)
q42v='4200V 2260 ED8400 8400 19 V 4700 SVR 5200 2727 520V 8400 2227 2110'
for mf,o in zip(mf42,['2260','ED8400','8400','19 V','4700 SVR','5200','2727','520V','8400','2227','2110']): rel('PDQ 4200V','cross_reference',f'{mf} {o}',QX,q42v)
G=['subject','relation','object','identity_evidence','source_pdf','source_url','page','quote']
w=csv.DictWriter(open('pdq_relations.csv','w',newline=''),G);w.writeheader();w.writerows(Rl)
print(len(M),len(Rl))
