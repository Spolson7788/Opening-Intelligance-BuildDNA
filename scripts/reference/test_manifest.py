import importlib.util, json, tempfile, unittest, shutil, os
from pathlib import Path
spec=importlib.util.spec_from_file_location('validator',Path(__file__).with_name('validate_manifest.py'))
validator=importlib.util.module_from_spec(spec);spec.loader.exec_module(validator)
ROOT=Path(os.environ.get('OI_REFERENCE_MANIFEST_DIR',Path(__file__).resolve().parents[2]/'reference-data'))
class ManifestTests(unittest.TestCase):
    def test_counts_and_source_identity(self):
        r=validator.validate(ROOT);self.assertEqual((r['documents'],r['pages']),(248,1952))
    def mutate(self,name,change):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t);shutil.copytree(ROOT,p,dirs_exist_ok=True)
            items=[json.loads(s) for s in (p/name).read_text().splitlines()];change(items)
            (p/name).write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in items))
            with self.assertRaises((AssertionError,KeyError)):validator.validate(p)
    def test_blank_page_never_citable(self):
        self.mutate('reference_pages.jsonl',lambda xs:next(x for x in xs if x['page_class']=='blank').update(citable=True))
    def test_fractions_never_citable(self):
        self.mutate('reference_pages.jsonl',lambda xs:next(x for x in xs if x['fraction_unverified']).update(citable=True))
    def test_model_without_evidence_rejected(self):
        self.mutate('reference_manifest.jsonl',lambda xs:xs[0]['models'][0].update(evidence_page=9999))
    def test_fabricated_retrieval_date_rejected(self):
        self.mutate('reference_manifest.jsonl',lambda xs:xs[0].update(retrieved_at='2026-10-02'))
    def test_changed_page_text_rejected(self):
        self.mutate('reference_pages.jsonl',lambda xs:xs[0].update(text='Changed source text'))
    def test_missing_corpus_document_rejected(self):
        self.mutate('reference_manifest.jsonl',lambda xs:xs.pop())
    def test_superseded_target_required(self):
        self.mutate('reference_manifest.jsonl',lambda xs:next(x for x in xs if x['status']=='superseded').update(superseded_by=None))
if __name__=='__main__':unittest.main()
