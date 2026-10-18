import gzip,hashlib,importlib.util,io,json,sqlite3,tarfile
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('portable_runtime',ROOT/'tools/install_runtime_bundle.py');runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)

def fixture(tmp_path, unsafe=False):
 root=tmp_path/'checkout';bundle=tmp_path/'bundle';bundle.mkdir();(root/'runtime').mkdir(parents=True);(root/'runtime/valhalla-runtime.json').write_text('{"mjolnir":{}}');resources=[]
 def resource(name,kind,target,plain,**extra):
  payload=gzip.compress(plain,mtime=0);parts=[]
  for n,start in enumerate(range(0,len(payload),19)):
   data=payload[start:start+19];namepart=f'{name}.part-{n:03}';(bundle/namepart).write_bytes(data);parts.append({'file':namepart,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
  resources.append({'id':name,'kind':kind,'target':target,'parts':parts,'sha256':hashlib.sha256(payload).hexdigest(),'bytes':len(plain),'contentSha256':hashlib.sha256(plain).hexdigest(),**extra})
 resource('roads','file',runtime.TARGETS['roads'],b'real-test-graph')
 resource('transit-index','sqlite-sql',runtime.TARGETS['transit-index'],b'BEGIN TRANSACTION;\nCREATE TABLE stops(id TEXT);\nINSERT INTO stops VALUES (\'S1\');\nCOMMIT;\n',tableCounts={'stops':1})
 target=io.BytesIO()
 with tarfile.open(fileobj=target,mode='w') as archive:
  data=b'route_id\nR1\n';info=tarfile.TarInfo('../escape.txt' if unsafe else 'offline-assets/transit-sources/gtfs/routes.txt');info.size=len(data);archive.addfile(info,io.BytesIO(data))
 resource('transit-sources','tar','.',target.getvalue());(bundle/'manifest.json').write_text(json.dumps({'schemaVersion':1,'id':'unit','resources':resources}));return root,bundle,resources

def test_install_restores_split_resources_and_is_idempotent(tmp_path):
 root,bundle,_=fixture(tmp_path);runtime.install(root,bundle);database=root/runtime.TARGETS['transit-index'];before=database.stat().st_mtime_ns;runtime.install(root,bundle)
 assert database.stat().st_mtime_ns==before
 with sqlite3.connect(database) as db:assert db.execute('SELECT * FROM stops').fetchall()==[('S1',)]
 assert (root/'offline-assets/transit-sources/gtfs/routes.txt').read_text()=='route_id\nR1\n'
 assert not (root/'site/.beego-data').exists()

def test_corrupt_part_is_rejected_before_any_install(tmp_path):
 root,bundle,items=fixture(tmp_path);p=bundle/items[-1]['parts'][0]['file'];p.write_bytes(b'corrupt')
 with pytest.raises(ValueError,match='runtime part'):runtime.install(root,bundle)
 assert not (root/runtime.TARGETS['roads']).exists()

def test_existing_database_is_never_replaced(tmp_path):
 root,bundle,_=fixture(tmp_path);database=root/runtime.TARGETS['transit-index'];database.parent.mkdir(parents=True);database.write_bytes(b'operator data')
 with pytest.raises(ValueError,match='Existing transit index is preserved'):runtime.install(root,bundle)
 assert database.read_bytes()==b'operator data'

def test_archive_cannot_escape_checkout(tmp_path):
 root,bundle,_=fixture(tmp_path,unsafe=True)
 with pytest.raises(ValueError,match='Unexpected transit archive'):runtime.install(root,bundle)
 assert not (tmp_path/'escape.txt').exists()

@pytest.mark.parametrize('path',['/tmp/escape','../escape','C:/escape','folder\\escape'])
def test_portable_paths_reject_absolute_and_parent_targets(tmp_path,path):
 with pytest.raises(ValueError):runtime.inside(tmp_path,path)
