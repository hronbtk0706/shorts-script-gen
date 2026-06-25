#!/usr/bin/env python3
"""
rezero_book_open_clean.glb の「表紙板(Cover)が紙より大きく左にはみ出す」問題を素材側で修正する。

背景:
  この本は紙を1枚めくった開きっぱなしの姿勢。左は紙が1枚(Page 1-2)だけで、その下の
  大きい表紙板(Cover メッシュ)が紙より外側に大きく出ているため、左ページに表紙内側の
  余白が見える。右は紙が11枚重なって表紙を隠すので出ない。
  → Cover 板を右表紙(couverture.001)と同じ外寸(背からの距離・高さ)に縮めて左右対称にする。
  紙(ページ)の頂点は一切触らない。

使い方:
  python fix_cover_overhang.py <path-to-glb>
  - 元ファイルは <glb>.orig_bak にバックアップ(既にあれば作らない)。
  - 既に縮小済みでも冪等(右表紙より外に出ている分だけ縮めるので、再実行で過剰縮小しない)。

別マシンでの再適用: その環境の glb パスを渡して実行すればよい。
"""
import struct, json, shutil, os, sys

def main(path):
    bak = path + ".orig_bak"
    if not os.path.exists(bak):
        shutil.copy2(path, bak); print("backup ->", bak)
    else:
        print("backup exists ->", bak)

    d = open(path, 'rb').read()
    _, _, total = struct.unpack('<III', d[:12])
    off = 12; js = None; bin_off = bin_len = None
    while off < total:
        clen, ctype = struct.unpack('<II', d[off:off+8]); off += 8
        if ctype == 0x4E4F534A: js = json.loads(d[off:off+clen].decode('utf-8'))
        elif ctype == 0x004E4942: bin_off, bin_len = off, clen
        off += clen
    BIN = bytearray(d[bin_off:bin_off+bin_len])
    acc = js['accessors']; bvs = js['bufferViews']

    def quat_mat(q):
        if not q: return [[1,0,0],[0,1,0],[0,0,1]]
        x,y,z,w = q
        return [[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]]
    def node_by(nm): return next(n for n in js['nodes'] if n.get('name') == nm)
    def read_verts(ai):
        a = acc[ai]; bv = bvs[a['bufferView']]
        base = bv.get('byteOffset',0)+a.get('byteOffset',0)
        return base, [struct.unpack_from('<3f', BIN, base+i*12) for i in range(a['count'])]

    # 右表紙の外寸を基準に
    rc = node_by('couverture.001'); M = quat_mat(rc.get('rotation'))
    t = rc.get('translation',[0,0,0]); s = rc.get('scale',[1,1,1])
    zmax_t = ymax_t = 0.0
    for pr in js['meshes'][rc['mesh']]['primitives']:
        _, vs = read_verts(pr['attributes']['POSITION'])
        for vx,vy,vz in vs:
            wy = M[1][0]*vx*s[0]+M[1][1]*vy*s[1]+M[1][2]*vz*s[2]+t[1]
            wz = M[2][0]*vx*s[0]+M[2][1]*vy*s[1]+M[2][2]*vz*s[2]+t[2]
            zmax_t = max(zmax_t, abs(wz)); ymax_t = max(ymax_t, abs(wy))
    targetOuter, targetY = zmax_t, ymax_t
    print(f"target(右表紙) outerZ={targetOuter:.4f} Y={targetY:.4f}")

    cov = node_by('Cover'); tz = cov['translation'][2]
    accs = sorted({pr['attributes']['POSITION'] for pr in js['meshes'][cov['mesh']]['primitives']})
    zmin_w = 1e9; zmax_w = -1e9; ymax_w = 0.0; data = {}
    for ai in accs:
        base, vs = read_verts(ai); data[ai] = (base, vs)
        for vx,vy,vz in vs:
            wz = vz+tz; zmin_w = min(zmin_w, wz); zmax_w = max(zmax_w, wz); ymax_w = max(ymax_w, abs(vy))
    print(f"Cover 現状 worldZ[{zmin_w:.4f},{zmax_w:.4f}] |Y|max={ymax_w:.4f}")
    sNeg = targetOuter/abs(zmin_w) if abs(zmin_w) > targetOuter else 1.0
    sPos = targetOuter/zmax_w if zmax_w > targetOuter else 1.0
    sY = targetY/ymax_w if ymax_w > targetY else 1.0
    if sNeg == 1.0 and sPos == 1.0 and sY == 1.0:
        print("既に右表紙と同寸以下。変更なし。"); return
    print(f"scale sNeg(左)={sNeg:.5f} sPos(右)={sPos:.5f} sY={sY:.5f}")

    for ai,(base,vs) in data.items():
        mins=[1e9]*3; maxs=[-1e9]*3
        for i,(vx,vy,vz) in enumerate(vs):
            wz = vz+tz; wz = wz*sNeg if wz<0 else wz*sPos
            nz = wz-tz; ny = vy*sY; nx = vx
            struct.pack_into('<3f', BIN, base+i*12, nx, ny, nz)
            for k,val in enumerate((nx,ny,nz)): mins[k]=min(mins[k],val); maxs[k]=max(maxs[k],val)
        acc[ai]['min']=mins; acc[ai]['max']=maxs

    json_bytes = json.dumps(js, separators=(',',':')).encode('utf-8')
    json_bytes += b' ' * ((4-(len(json_bytes)%4))%4)
    BIN += b'\x00' * ((4-(len(BIN)%4))%4)
    out = bytearray()
    out += struct.pack('<III', 0x46546C67, 2, 12+8+len(json_bytes)+8+len(BIN))
    out += struct.pack('<II', len(json_bytes), 0x4E4F534A) + json_bytes
    out += struct.pack('<II', len(BIN), 0x004E4942) + bytes(BIN)
    open(path, 'wb').write(out)
    print(f"written {len(out)} bytes ->", path)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python fix_cover_overhang.py <path-to-glb>"); sys.exit(1)
    main(sys.argv[1])
