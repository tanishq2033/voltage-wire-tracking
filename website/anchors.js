// Anchors module: stores world-fixed 3D points, observations and persistence.
const Anchors = (() => {
  const anchors = []; // {id, world: [x,y,z] or null, obs: [{u,v,pose,K}], meta}
  let nextId = 1;
  const LS_KEY = 'vwt_anchors_v1';

  function clear() { anchors.length = 0; save(); }

  function add(worldPos, meta){
    const a = { id: nextId++, world: worldPos ? worldPos.slice() : null, obs: [], meta: meta || {} };
    anchors.push(a); save(); return a;
  }

  function findNearbyPixel(u,v, thresh=30){
    // search projected anchors from most recent pose if possible (caller provides pose normally)
    // fallback: find anchor with no world but with obs projecting near pixel
    for (const a of anchors){
      if (a.world && a._lastProj){
        const dx = a._lastProj.x - u, dy = a._lastProj.y - v;
        if (Math.hypot(dx,dy) <= thresh) return a;
      } else if (!a.world && a.obs.length){
        const last = a.obs[a.obs.length-1];
        const ddx = last.u - u, ddy = last.v - v;
        if (Math.hypot(ddx,ddy) <= thresh) return a;
      }
    }
    return null;
  }

  function addObservationForPixel(u,v, pose, K){
    // attach observation to nearby anchor or create new pending anchor
    const near = findNearbyPixel(u,v);
    let a = near;
    if (!a) a = add(null, {source: 'esp_pending'});
    a.obs.push({ u,v, pose, K });
    save();
    // Try triangulation when we have >=3 diverse observations
    if (!a.world && a.obs.length >= 3){
      const world = triangulateObservations(a.obs);
      if (world) { a.world = world; a.meta.source = 'esp'; save(); }
    }
    return a;
  }

  // Project all anchors into image using pose and K. Returns array of {id, x,y,meta}
  function projectAll(pose, K){
    const out = [];
    if (!pose || !pose.R || !pose.t) return out;
    const R = pose.R, t = pose.t;
    for (const a of anchors){
      if (!a.world) continue;
      const X = a.world;
      const xc = R[0][0]*X[0] + R[0][1]*X[1] + R[0][2]*X[2] + t[0];
      const yc = R[1][0]*X[0] + R[1][1]*X[1] + R[1][2]*X[2] + t[1];
      const zc = R[2][0]*X[0] + R[2][1]*X[1] + R[2][2]*X[2] + t[2];
      if (zc <= 0) continue;
      const u = (K[0][0]*xc + K[0][2]*zc) / zc;
      const v = (K[1][1]*yc + K[1][2]*zc) / zc;
      a._lastProj = { x: u, y: v };
      out.push({ id: a.id, x: u, y: v, meta: a.meta });
    }
    return out;
  }

  function getAll(){ return anchors.map(a=>({ id:a.id, world:a.world, meta:a.meta, obsCount: a.obs.length })); }

  // Linear algebra helpers
  function dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
  function norm(v){ return Math.sqrt(dot(v,v)); }
  function scale(v,s){ return [v[0]*s, v[1]*s, v[2]*s]; }
  function sub(a,b){ return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
  function addV(a,b){ return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
  function outer(a,b){ return [[a[0]*b[0], a[0]*b[1], a[0]*b[2]],[a[1]*b[0],a[1]*b[1],a[1]*b[2]],[a[2]*b[0],a[2]*b[1],a[2]*b[2]]]; }

  // Triangulate by intersecting rays from multiple observations.
  // Each obs: pixel (u,v), pose (R,t), K.
  // Compute camera center C = -R^T * t and ray direction d = R^T * K^{-1} * [u,v,1]
  // Solve least-squares for point X minimizing sum || (I - d d^T)(X - C) ||^2
  function triangulateObservations(obs){
    const A = [[0,0,0],[0,0,0],[0,0,0]]; // 3x3
    const b = [0,0,0];
    for (const o of obs){
      try {
        const Kinv = invert3(o.K);
        const uv1 = [o.u, o.v, 1];
        // dir_cam = Kinv * uv1
        const dir_cam = [ Kinv[0][0]*uv1[0] + Kinv[0][1]*uv1[1] + Kinv[0][2]*uv1[2], Kinv[1][0]*uv1[0] + Kinv[1][1]*uv1[1] + Kinv[1][2]*uv1[2], Kinv[2][0]*uv1[0] + Kinv[2][1]*uv1[1] + Kinv[2][2]*uv1[2] ];
        // dir_world = R^T * dir_cam
        const R = o.pose.R, t = o.pose.t;
        const dir_world = [ R[0][0]*dir_cam[0] + R[1][0]*dir_cam[1] + R[2][0]*dir_cam[2], R[0][1]*dir_cam[0] + R[1][1]*dir_cam[1] + R[2][1]*dir_cam[2], R[0][2]*dir_cam[0] + R[1][2]*dir_cam[1] + R[2][2]*dir_cam[2] ];
        const d = scale(dir_world, 1 / norm(dir_world));
        // camera center C = -R^T * t
        const C = [ -(R[0][0]*t[0] + R[1][0]*t[1] + R[2][0]*t[2]), -(R[0][1]*t[0] + R[1][1]*t[1] + R[2][1]*t[2]), -(R[0][2]*t[0] + R[1][2]*t[1] + R[2][2]*t[2]) ];
        // compute (I - d d^T)
        const dd = outer(d,d);
        const I = [[1,0,0],[0,1,0],[0,0,1]];
        const M = [[ I[0][0]-dd[0][0], I[0][1]-dd[0][1], I[0][2]-dd[0][2] ], [ I[1][0]-dd[1][0], I[1][1]-dd[1][1], I[1][2]-dd[1][2] ], [ I[2][0]-dd[2][0], I[2][1]-dd[2][1], I[2][2]-dd[2][2] ]];
        // accumulate A += M^T * M (but M symmetric so M^T*M = M*M)
        for (let i=0;i<3;i++) for (let j=0;j<3;j++) A[i][j] += M[i][j];
        // accumulate b += M * (M * C) ~ M * C
        const MC = [ M[0][0]*C[0] + M[0][1]*C[1] + M[0][2]*C[2], M[1][0]*C[0] + M[1][1]*C[1] + M[1][2]*C[2], M[2][0]*C[0] + M[2][1]*C[1] + M[2][2]*C[2] ];
        b[0] += MC[0]; b[1] += MC[1]; b[2] += MC[2];
      } catch (e){ return null; }
    }
    // solve A x = b
    try {
      const x = solve3(A,b);
      return x;
    } catch (e){ return null; }
  }

  // small 3x3 solver via Cramer's rule
  function det3(m){
    return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1]) - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0]) + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  }
  function solve3(A,b){
    const D = det3(A); if (Math.abs(D) < 1e-9) throw new Error('singular');
    const A0 = [[b[0],A[0][1],A[0][2]],[b[1],A[1][1],A[1][2]],[b[2],A[2][1],A[2][2]]];
    const A1 = [[A[0][0],b[0],A[0][2]],[A[1][0],b[1],A[1][2]],[A[2][0],b[2],A[2][2]]];
    const A2 = [[A[0][0],A[0][1],b[0]],[A[1][0],A[1][1],b[1]],[A[2][0],A[2][1],b[2]]];
    return [ det3(A0)/D, det3(A1)/D, det3(A2)/D ];
  }

  // invert 3x3
  function invert3(m){
    const det = det3(m); if (Math.abs(det) < 1e-12) throw new Error('singular');
    const invDet = 1/det;
    const inv = [
      [ (m[1][1]*m[2][2]-m[1][2]*m[2][1])*invDet, (m[0][2]*m[2][1]-m[0][1]*m[2][2])*invDet, (m[0][1]*m[1][2]-m[0][2]*m[1][1])*invDet],
      [ (m[1][2]*m[2][0]-m[1][0]*m[2][2])*invDet, (m[0][0]*m[2][2]-m[0][2]*m[2][0])*invDet, (m[0][2]*m[1][0]-m[0][0]*m[1][2])*invDet],
      [ (m[1][0]*m[2][1]-m[1][1]*m[2][0])*invDet, (m[0][1]*m[2][0]-m[0][0]*m[2][1])*invDet, (m[0][0]*m[1][1]-m[0][1]*m[1][0])*invDet]
    ];
    return inv;
  }

  // persistence
  function save(){
    try { const s = JSON.stringify(anchors.map(a=>({id:a.id, world:a.world, obs:a.obs.length? a.obs.map(o=>({u:o.u,v:o.v})):[], meta:a.meta}))); localStorage.setItem(LS_KEY,s); }catch(e){}
  }
  function load(){
    try{ const s = localStorage.getItem(LS_KEY); if (!s) return; const arr = JSON.parse(s); for (const e of arr){ const a = { id: e.id, world: e.world, obs: [], meta: e.meta || {} }; anchors.push(a); nextId = Math.max(nextId, a.id+1); } }catch(e){}
  }

  // load on startup
  load();

  return { clear, add, addObservationForPixel, projectAll, getAll };
})();
