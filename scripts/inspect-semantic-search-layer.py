import sys,tarfile,hashlib,json,re,struct,email
out=[]
def elf(data):
 if data[:6]!=b'\x7fELF\x02\x01':return None
 try:
  phoff=struct.unpack_from('<Q',data,32)[0];ents,count=struct.unpack_from('<HH',data,54)
  ph=[struct.unpack_from('<IIQQQQQQ',data,phoff+i*ents) for i in range(count)]
  dy=next((p for p in ph if p[0]==2),None)
  if not dy:return None
  ds=[]
  for i in range(dy[2],dy[2]+dy[5],16):
   tag,v=struct.unpack_from('<qQ',data,i)
   if tag==0:break
   ds.append((tag,v))
  addr=next(v for t,v in ds if t==5);load=next(p for p in ph if p[0]==1 and p[3]<=addr<p[3]+p[5]);base=load[2]+addr-load[3]
  def st(v):
   pos=base+v;return data[pos:data.index(b'\0',pos)].decode()
  return {'needed':[st(v) for t,v in ds if t==1],'rpath':[st(v) for t,v in ds if t in (15,29)]}
 except (ValueError,StopIteration,struct.error):return {'parse':'unavailable'}
with tarfile.open(sys.argv[1],'r:*') as tf:
 for m in tf:
  p=m.name.removeprefix('./').lstrip('/')
  if '/.wh.' in p or p.startswith('.wh.'):
   out.append({'path':p,'whiteout':True});continue
  selected=p in ['etc/os-release','usr/lib/os-release','var/lib/dpkg/status','usr/local/bin/python3.12'] or p.startswith('usr/local/lib/claus-native/') or p.startswith('usr/lib/x86_64-linux-gnu/libstdc++') or p.startswith('usr/lib/x86_64-linux-gnu/libgomp') or p.startswith('app/') or p.endswith('.dist-info/METADATA') or p.startswith('usr/local/lib/python3.12/site-packages/') and '.so' in p
  if not selected or m.isdir():continue
  rec={'path':p,'bytes':m.size}
  if m.issym() or m.islnk():rec['link']=m.linkname
  elif m.isfile():
   f=tf.extractfile(m);h=hashlib.sha256();chunks=[];capture=p in ['etc/os-release','usr/lib/os-release','var/lib/dpkg/status'] or p.endswith('.dist-info/METADATA') or '.so' in p or p=='usr/local/bin/python3.12'
   while b:=f.read(1024*1024):
    h.update(b)
    if capture:chunks.append(b)
   rec['sha256']=h.hexdigest();data=b''.join(chunks)
   if p in ['etc/os-release','usr/lib/os-release']:rec['text']=data.decode()
   elif p=='var/lib/dpkg/status':
    rec['packages']=[]
    for part in data.decode().split('\n\n'):
     msg=email.message_from_string(part)
     if msg['Package']:rec['packages'].append({k:msg[k] for k in ['Package','Version','Architecture','Status']})
   elif p.endswith('.dist-info/METADATA'):
    msg=email.message_from_bytes(data);rec['distribution']={'name':msg['Name'],'version':msg['Version'],'requires':msg.get_all('Requires-Dist',[])}
   elif data:
    e=elf(data)
    if e:rec['elf']=e
    if 'libstdc++' in p or 'libgomp' in p:rec['symbolVersions']=sorted(set(x.decode() for x in re.findall(rb'(?:GLIBCXX|GLIBC|CXXABI|GOMP)_[0-9.]+',data)))
  out.append(rec)
print(json.dumps(out))
