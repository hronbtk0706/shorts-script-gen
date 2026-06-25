#!/usr/bin/env python3
"""
めくり後の Page 3-4 が Page 1-2 より手前(上)か奥(下)かを、カメラ空間の深度で計算で確認する。
（描画を見られない環境で「潜り込み」を推測せず数値で判定するための道具。）

使い方:
  python check_flip_depth.py <path-to-glb> [yaw] [pitch] [distance]
  既定 yaw=-90 pitch=-3 distance=6.3 (test-bookflip-h.json の bookCamera と同じ)

出力: 左側領域での Page1-2 と「めくった Page3-4」の平均カメラ深度(小さいほど手前=上)。
"""
import struct, json, math, sys

def main(path, yaw_deg=-90.0, pitch_deg=-3.0, dist=6.3):
    d = open(path,'rb').read(); _,_,L = struct.unpack('<III', d[:12])
    off=12; js=None; BIN=None
    while off < L:
        cl,ct = struct.unpack('<II', d[off:off+8]); off+=8
        if ct==0x4E4F534A: js=json.loads(d[off:off+cl].decode('utf-8'))
        elif ct==0x004E4942: BIN=d[off:off+cl]
        off+=cl
    acc=js['accessors']; bvs=js['bufferViews']
    def verts(mi):
        out=[]
        for pr in js['meshes'][mi]['primitives']:
            a=acc[pr['attributes']['POSITION']]; bv=bvs[a['bufferView']]
            base=bv.get('byteOffset',0)+a.get('byteOffset',0)
            out += [list(struct.unpack_from('<3f',BIN,base+i*12)) for i in range(a['count'])]
        return out
    def quat_mat(q):
        if not q: return [[1,0,0],[0,1,0],[0,0,1]]
        x,y,z,w=q
        return [[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]]
    def world_node(n):
        M=quat_mat(n.get('rotation')); t=n.get('translation',[0,0,0]); s=n.get('scale',[1,1,1])
        return [[M[i][0]*vx*s[0]+M[i][1]*vy*s[1]+M[i][2]*vz*s[2]+t[i] for i in range(3)] for vx,vy,vz in verts(n['mesh'])]
    amn=[1e9]*3; amx=[-1e9]*3
    for n in js['nodes']:
        if n.get('mesh') is None: continue
        for w in world_node(n):
            for k in range(3): amn[k]=min(amn[k],w[k]); amx[k]=max(amx[k],w[k])
    center=[(amn[k]+amx[k])/2 for k in range(3)]
    nb=lambda nm: next(n for n in js['nodes'] if n.get('name')==nm)
    p12=[[w[k]-center[k] for k in range(3)] for w in world_node(nb('Page 1-2'))]
    p34=world_node(nb('Page 3-4'))
    p34f=[[-w[0]-center[0], w[1]-center[1], -w[2]-center[2]] for w in p34]  # Y軸180°回転後
    yaw=math.radians(yaw_deg); pitch=math.radians(pitch_deg)
    dirc=[math.sin(yaw)*math.cos(pitch), math.sin(pitch), math.cos(yaw)*math.cos(pitch)]
    cam=[dirc[k]*dist for k in range(3)]
    vd=[-c for c in dirc]
    depth=lambda p: sum((p[k]-cam[k])*vd[k] for k in range(3))
    ml=lambda vs: (lambda ds: sum(ds)/len(ds) if ds else None)([depth(p) for p in vs if p[2]<0])
    d12, d34 = ml(p12), ml(p34f)
    print(f"camera={[round(c,2) for c in cam]}")
    print(f"左側平均カメラ深度(小=手前=上):  Page1-2={d12:.4f}  めくったPage3-4={d34:.4f}")
    print("=> " + ("Page3-4が手前(上)＝正常" if d34 < d12 else f"Page3-4が奥(下)＝潜る (差{d12-d34:.4f}) → setMeshOnTopで最前面強制が必要"))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python check_flip_depth.py <path-to-glb> [yaw] [pitch] [distance]"); sys.exit(1)
    a = sys.argv
    main(a[1], float(a[2]) if len(a)>2 else -90.0, float(a[3]) if len(a)>3 else -3.0, float(a[4]) if len(a)>4 else 6.3)
