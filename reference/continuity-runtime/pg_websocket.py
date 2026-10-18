"""Binary PostgreSQL stream over authenticated HTTPS/WebSocket transport.

The destination is fixed localhost. PostgreSQL performs SCRAM authentication;
only explicitly enabled database roles can connect. No URL can select a target.
"""
import base64, hashlib, socket, struct, threading
SLOTS=threading.BoundedSemaphore(32)
def serve(handler):
    key=handler.headers.get('Sec-WebSocket-Key','')
    try: valid=len(base64.b64decode(key,validate=True))==16
    except ValueError: valid=False
    if not valid or handler.headers.get('Upgrade','').lower()!='websocket' or handler.headers.get('Sec-WebSocket-Version')!='13':
        return handler.reply(400,{'error':'websocket_required'})
    if not SLOTS.acquire(blocking=False):return handler.reply(503,{'error':'connection_capacity'})
    backend=None;writer=threading.Lock();closed=threading.Event()
    def send(opcode,payload):
        n=len(payload);header=bytes([0x80|opcode,n]) if n<126 else bytes([0x80|opcode,126])+struct.pack('!H',n) if n<=65535 else bytes([0x80|opcode,127])+struct.pack('!Q',n)
        with writer: handler.wfile.write(header+payload);handler.wfile.flush()
    try:
        backend=socket.create_connection(('127.0.0.1',5440),timeout=10);backend.settimeout(180)
        handler.send_response(101);handler.send_header('Upgrade','websocket');handler.send_header('Connection','Upgrade');handler.send_header('Sec-WebSocket-Accept',base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode());handler.end_headers();handler.wfile.flush()
        handler.connection.settimeout(180)
        def read_exact(n):
            out=bytearray()
            while len(out)<n:
                b=handler.rfile.read(n-len(out))
                if not b:raise EOFError()
                out.extend(b)
            return bytes(out)
        def read_postgres():
            try:
                while not closed.is_set():
                    data=backend.recv(65536)
                    if not data:break
                    send(2,data)
            except (OSError,ValueError):pass
            finally:
                closed.set()
                try:handler.connection.shutdown(socket.SHUT_RD)
                except OSError:pass
        thread=threading.Thread(target=read_postgres,daemon=True);thread.start();fragment=False
        while not closed.is_set():
            first,second=read_exact(2);opcode=first&15;final=bool(first&128)
            if first&0x70 or not second&128:raise ValueError('invalid_client_frame')
            length=second&127
            if length==126:length=struct.unpack('!H',read_exact(2))[0]
            elif length==127:length=struct.unpack('!Q',read_exact(8))[0]
            if length>8*1024*1024:raise ValueError('frame_too_large')
            if opcode>=8 and (not final or length>125):raise ValueError('invalid_control_frame')
            mask=read_exact(4);raw=read_exact(length);payload=bytes(v^mask[i%4] for i,v in enumerate(raw))
            if opcode==8:send(8,payload[:125]);break
            if opcode==9:send(10,payload);continue
            if opcode==10:continue
            if opcode==2:
                if fragment:raise ValueError('nested_fragment')
                fragment=not final
            elif opcode==0:
                if not fragment:raise ValueError('unexpected_fragment')
                fragment=not final
            else:raise ValueError('binary_frames_required')
            backend.sendall(payload)
    except (OSError,EOFError,ValueError):pass
    finally:
        closed.set()
        if backend:
            try:backend.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            backend.close()
        handler.close_connection=True;SLOTS.release()
