/* ============================================================================
 *  户型编辑器 —— floorplan-3d 内置的户型编辑模块
 *
 *  把原本硬编码在 index.html 里的户型几何（房间 / 墙体 / 窗 / 门）变成
 *  运行期可编辑的数据：
 *    · 数据存在 state.plan，随方案一起撤销 / 重做、保存到 localStorage、
 *      导入导出 JSON
 *    · index.html 侧只做了「常量 → state.plan」的管道改造，读取点零改动
 *
 *  本文件是普通 <script>（不是 module），file:// 下也能直接加载。
 *  复用主脚本的全局绑定：state / ROOMS / WALLS / WINS / DOORS / mutate /
 *  renderAll / renderSel / renderPanel / toMM / tr / nm / MATS ...
 * ========================================================================== */
(function(){
'use strict';

/* ------------------------------------------------------------------ 状态 */
let planMode   = false;   // 是否处于户型编辑模式
let addMode    = null;    // 当前添加子模式：room | wall | win | door | null
let psel       = null;    // 选中元素 {kind, id}
let pdrag      = null;    // 拖拽过程
let roomSeq    = 0;       // 新房间序号
let followRoom = true;    // 房间尺寸变化时，贴合的墙体跟着走
let paletteKey = '';      // 左侧调色板缓存键，避免每次改动都重建 DOM
let planSeg    = 'edit';  // 户型编辑器的两段：edit = 改房间，gen = 生成户型
let genArea    = 90;      // 生成器：套内使用面积 m²
let genRatio   = 1;       // 生成器：外形长宽比（1 = 正方形）
let genTpl     = '3r';    // 生成器：户型模板

/* -------------------------------------------------------------- 小工具 */
const el = s => document.querySelector(s);
const svgEl = () => el('#plan');
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const snapPt = p => ({x: Math.round(p.x/10)*10, y: Math.round(p.y/10)*10});
const is3d = () => document.body.classList.contains('m3d');

/* 元素读取（墙 / 窗 / 门按数组下标编号，房间用稳定 id） */
const roomOf = id => ROOMS.find(r => r.id === id);
const wallOf = id => WALLS[+String(id).slice(1)];
const winOf  = id => WINS[+String(id).slice(1)];
const doorOf = id => DOORS[+String(id).slice(1)];
const wid = i => 'w' + i, iid = i => 'i' + i, did = i => 'd' + i;

function elemRect(kind, id){
  if (kind === 'room'){ const r = roomOf(id); return r ? rectOf(r.poly) : null; }
  if (kind === 'wall'){ const w = wallOf(id); if (!w) return null;
    return {x0:Math.min(w[0],w[2]), y0:Math.min(w[1],w[3]), x1:Math.max(w[0],w[2]), y1:Math.max(w[1],w[3])}; }
  if (kind === 'win'){ const w = winOf(id); return w ? {x0:w[0], y0:w[1], x1:w[2], y1:w[3]} : null; }
  if (kind === 'door'){ const d = doorOf(id); return d ? {x0:d.rect[0], y0:d.rect[1], x1:d.rect[2], y1:d.rect[3]} : null; }
  return null;
}
// 轴对齐矩形判定（非矩形房间只允许移动，不允许拖手柄改尺寸）
function rectOf(poly){
  if (!poly || poly.length !== 4) return null;
  const xs = poly.map(p=>p[0]), ys = poly.map(p=>p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let s = 0;
  for (let i = 0; i < 4; i++){ const p = poly[i], q = poly[(i+1)%4]; s += p[0]*q[1] - q[0]*p[1]; }
  if (Math.abs(Math.abs(s)/2 - (x1-x0)*(y1-y0)) > 1) return null;
  return {x0, y0, x1, y1};
}
function setRect(kind, id, r){
  if (kind === 'room'){
    const room = roomOf(id); if (!room) return;
    room.poly = [[r.x0,r.y0],[r.x1,r.y0],[r.x1,r.y1],[r.x0,r.y1]];
    room.at = [(r.x0+r.x1)/2, (r.y0+r.y1)/2];
  } else if (kind === 'wall'){
    const w = wallOf(id); if (!w) return;
    w[0] = Math.min(r.x0, r.x1); w[1] = Math.min(r.y0, r.y1);
    w[2] = Math.max(r.x0, r.x1); w[3] = Math.max(r.y0, r.y1);
  } else if (kind === 'win'){
    const w = winOf(id); if (!w) return;
    w[0] = r.x0; w[1] = r.y0; w[2] = r.x1; w[3] = r.y1;
  } else if (kind === 'door'){
    const d = doorOf(id); if (!d) return;
    d.rect = [r.x0, r.y0, r.x1, r.y1];
    const cx = (r.x0+r.x1)/2, cy = (r.y0+r.y1)/2;
    const horiz = (r.x1-r.x0) >= (r.y1-r.y0);
    if (horiz){ d.h = [r.x0, cy]; d.len = r.x1-r.x0; } else { d.h = [cx, r.y0]; d.len = r.y1-r.y0; }
  }
}

/* --------------------------------------------------------- 变更与持久化 */
function planMutate(fn, keepSel){
  mutate(() => fn());
  if (!keepSel) psel = null;
  renderPlanUI();
}

/* ---------------------------------------------------- 墙体增删（保下标） */
function insertWall(w, at){
  const i = (at == null ? WALLS.length : at);
  WALLS.splice(i, 0, w);
  state.demolished = state.demolished.map(id => { const n = +id.slice(1); return 'w' + (n >= i ? n+1 : n); });
}
function removeWall(i){
  WALLS.splice(i, 1);
  state.demolished = state.demolished
    .filter(id => +id.slice(1) !== i)
    .map(id => { const n = +id.slice(1); return 'w' + (n > i ? n-1 : n); });
}

/* ------------------------------------------------------------ 元素增删 */
function addRoom(r){
  roomSeq++;
  const id = 'r' + roomSeq + '_' + Math.floor(Math.random()*1e4).toString(36);
  const name = tr('房间', 'Room') + ' ' + roomSeq;
  ROOMS.push({id, name, poly: [[r.x0,r.y0],[r.x1,r.y0],[r.x1,r.y1],[r.x0,r.y1]], mat: 'tile800', at: [(r.x0+r.x1)/2, (r.y0+r.y1)/2]});
  state.rooms[id] = {name, mat: 'tile800'};
  return id;
}
function removeRoom(id){
  const i = ROOMS.findIndex(r => r.id === id);
  if (i < 0) return;
  ROOMS.splice(i, 1);
  delete state.rooms[id];
}
function addWin(rect, sill){
  WINS.push([rect.x0, rect.y0, rect.x1, rect.y1, sill == null ? .9 : sill]);
  return iid(WINS.length - 1);
}
function removeWin(i){ WINS.splice(i, 1); }
function addDoor(rect, o, c){
  const cx = (rect.x0+rect.x1)/2, cy = (rect.y0+rect.y1)/2;
  const horiz = (rect.x1-rect.x0) >= (rect.y1-rect.y0);
  const d = {name: tr('门', 'Door'), rect: [rect.x0, rect.y0, rect.x1, rect.y1],
             h: horiz ? [rect.x0, cy] : [cx, rect.y0], c, o,
             len: horiz ? rect.x1-rect.x0 : rect.y1-rect.y0};
  DOORS.push(d);
  return did(DOORS.length - 1);
}
function removeDoor(i){ DOORS.splice(i, 1); }

/* -------------------------------------------- 房间尺寸变化时墙体跟随 */
// 把与房间某条边「面重合」的墙体一起平移，避免房间改了、墙还停在原地。
// 只带动该边外侧那一侧的墙：右边界带动 x0 === 右边界的墙，左边界带动 x1 === 左边界的墙。
function followWallsForRoom(id, before, after){
  if (!followRoom) return;
  const rules = [];
  if (Math.abs(before.x1 - after.x1) > 1) rules.push({axis:'x', face:'x0', v:before.x1, to:after.x1, a:before.y0, b:before.y1});
  if (Math.abs(before.x0 - after.x0) > 1) rules.push({axis:'x', face:'x1', v:before.x0, to:after.x0, a:before.y0, b:before.y1});
  if (Math.abs(before.y1 - after.y1) > 1) rules.push({axis:'y', face:'y0', v:before.y1, to:after.y1, a:before.x0, b:before.x1});
  if (Math.abs(before.y0 - after.y0) > 1) rules.push({axis:'y', face:'y1', v:before.y0, to:after.y0, a:before.x0, b:before.x1});
  for (const m of rules){
    const delta = m.to - m.v;
    WALLS.forEach(w => {
      const x0 = Math.min(w[0], w[2]), x1 = Math.max(w[0], w[2]);
      const y0 = Math.min(w[1], w[3]), y1 = Math.max(w[1], w[3]);
      if (m.axis === 'x'){
        // 只带动「基本就是这条边」的那段墙：重叠长度需过半，避免误带动只擦到一角的墙
        const ov = Math.min(y1, m.b) - Math.max(y0, m.a);
        const span = Math.min(y1-y0, m.b-m.a);
        if (ov <= 0 || ov < span*0.5) return;
        // 整段平移（而不是只挪一个面），否则墙会被拉厚
        if (m.face === 'x0' && x0 === m.v){ w[0] += delta; w[2] += delta; }
        else if (m.face === 'x1' && x1 === m.v){ w[0] += delta; w[2] += delta; }
      } else {
        const ov = Math.min(x1, m.b) - Math.max(x0, m.a);
        const span = Math.min(x1-x0, m.b-m.a);
        if (ov <= 0 || ov < span*0.5) return;
        if (m.face === 'y0' && y0 === m.v){ w[1] += delta; w[3] += delta; }
        else if (m.face === 'y1' && y1 === m.v){ w[1] += delta; w[3] += delta; }
      }
    });
  }
}

/* -------------------------------------------------------------- 命中检测 */
// 找到离点击点最近的墙体（屏幕空间容差，与缩放无关）
function wallNear(p, tol){
  let best = -1, bd = Infinity;
  for (let i = 0; i < WALLS.length; i++){
    const w = WALLS[i];
    const x0 = Math.min(w[0], w[2]), x1 = Math.max(w[0], w[2]);
    const y0 = Math.min(w[1], w[3]), y1 = Math.max(w[1], w[3]);
    const cx = clamp(p.x, x0, x1), cy = clamp(p.y, y0, y1);
    const d = Math.hypot(p.x-cx, p.y-cy);
    if (d < bd && d <= tol){ bd = d; best = i; }
  }
  return best;
}

/* =======================================================================
 *  渲染：选中框 / 拖拽手柄 / 门窗命中区 / 绘制预览
 * ==================================================================== */
const AC = 'stroke="#b5653a" vector-effect="non-scaling-stroke"';
function renderPlanOverlay(){
  const k = 1/view.s, out = [];
  const hit = (COARSE ? 22 : 10)*k, hs = COARSE ? 1.6 : 1;

  // 门窗命中区（主脚本渲染门窗时没有 data 属性，这里叠一层热区）
  WINS.forEach((w, i) => {
    const sel = psel && psel.kind === 'win' && psel.id === iid(i);
    const [x0,y0,x1,y1] = w;
    out.push(`<rect data-pk="win" data-pid="${iid(i)}" x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}"
      fill="transparent" ${sel ? `fill="rgba(181,101,58,.18)" ${AC} stroke-width="2"` : ''}/>`);
  });
  DOORS.forEach((d, i) => {
    const sel = psel && psel.kind === 'door' && psel.id === did(i);
    const [x0,y0,x1,y1] = d.rect;
    out.push(`<rect data-pk="door" data-pid="${did(i)}" x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}"
      fill="transparent" ${sel ? `fill="rgba(181,101,58,.18)" ${AC} stroke-width="2"` : ''}/>`);
  });

  // 选中元素的框与手柄
  if (psel){
    const r = elemRect(psel.kind, psel.id);
    if (r){
      const w = r.x1-r.x0, h = r.y1-r.y0;
      out.push(`<rect x="${r.x0}" y="${r.y0}" width="${w}" height="${h}" fill="none" ${AC}
        stroke-width="1.6" stroke-dasharray="6 4" pointer-events="none"/>`);
      const hs2 = 6*hs*k;
      const handle = (ph, x, y) => `<circle data-ph="${ph}" cx="${x}" cy="${y}" r="${hit}" fill="transparent"/>
        <rect data-ph="${ph}" x="${x-hs2}" y="${y-hs2}" width="${hs2*2}" height="${hs2*2}" fill="#b5653a" stroke="#fff" stroke-width="1"/>`;
      if (psel.kind === 'room'){
        if (rectOf(roomOf(psel.id) && roomOf(psel.id).poly)){
          out.push(handle('nw', r.x0, r.y0), handle('ne', r.x1, r.y0), handle('sw', r.x0, r.y1), handle('se', r.x1, r.y1));
          out.push(handle('n', (r.x0+r.x1)/2, r.y0), handle('s', (r.x0+r.x1)/2, r.y1));
          out.push(handle('w', r.x0, (r.y0+r.y1)/2), handle('e', r.x1, (r.y0+r.y1)/2));
        }
      } else if (w >= h){
        out.push(handle('wl', r.x0, (r.y0+r.y1)/2), handle('wr', r.x1, (r.y0+r.y1)/2));
      } else {
        out.push(handle('wt', (r.x0+r.x1)/2, r.y0), handle('wb', (r.x0+r.x1)/2, r.y1));
      }
      out.push(`<text x="${(r.x0+r.x1)/2}" y="${r.y1 + 22*k}" font-size="${12*k}" text-anchor="middle" fill="#b5653a"
        font-weight="600" pointer-events="none" stroke="#fff" stroke-width="${3*k}" paint-order="stroke">${sizeLabel(psel.kind, r)}</text>`);
    }
  }

  // 绘制中的预览
  if (pdrag && pdrag.kind === 'newroom'){
    const a = pdrag.a, b = pdrag.b || a;
    out.push(`<rect x="${Math.min(a.x,b.x)}" y="${Math.min(a.y,b.y)}" width="${Math.abs(b.x-a.x)}" height="${Math.abs(b.y-a.y)}"
      fill="rgba(181,101,58,.12)" ${AC} stroke-width="2" stroke-dasharray="6 4" pointer-events="none"/>`);
  }
  if (pdrag && pdrag.kind === 'newwall'){
    const r = wallRectFrom(pdrag.a, pdrag.b || pdrag.a, pdrag.shift);
    if (r) out.push(`<rect x="${r.x0}" y="${r.y0}" width="${r.x1-r.x0}" height="${r.y1-r.y0}"
      fill="rgba(181,101,58,.25)" ${AC} stroke-width="1.5" pointer-events="none"/>`);
  }
  el('#gSel').innerHTML = out.join('');
}
function sizeLabel(kind, r){
  if (kind === 'room') return Math.round(r.x1-r.x0) + ' × ' + Math.round(r.y1-r.y0);
  const w = r.x1-r.x0, h = r.y1-r.y0;
  return Math.round(Math.max(w,h)) + ' × ' + Math.round(Math.min(w,h));
}

/* =======================================================================
 *  交互
 * ==================================================================== */
function wallRectFrom(a, b, shift){
  const dx = b.x-a.x, dy = b.y-a.y;
  if (!dx && !dy) return null;
  let horiz = Math.abs(dx) >= Math.abs(dy);
  if (shift) horiz = !horiz;
  const t = 240;
  return horiz
    ? {x0: Math.min(a.x,b.x), y0: a.y-t/2, x1: Math.max(a.x,b.x), y1: a.y+t/2}
    : {x0: a.x-t/2, y0: Math.min(a.y,b.y), x1: a.x+t/2, y1: Math.max(a.y,b.y)};
}

function onPlanPointerDown(e){
  if (!planMode) return false;
  if (is3d()) return false;
  const t = e.target;
  const p = toMM(e);

  // 1) 拖手柄
  const h = t.closest && t.closest('[data-ph]');
  if (h && psel){
    const before = elemRect(psel.kind, psel.id);
    if (before){
      pdrag = {kind:'handle', ph:h.dataset.ph, pk:psel.kind, pid:psel.id, orig: clone(before), rect: clone(before)};
      svgEl().setPointerCapture(e.pointerId);
      return true;
    }
  }
  // 2) 添加模式
  if (addMode === 'room'){
    pdrag = {kind:'newroom', a: snapPt(p)};
    svgEl().setPointerCapture(e.pointerId);
    return true;
  }
  if (addMode === 'wall'){
    pdrag = {kind:'newwall', a: snapPt(p), shift: e.shiftKey};
    svgEl().setPointerCapture(e.pointerId);
    return true;
  }
  if (addMode === 'win' || addMode === 'door'){
    placeOpening(addMode, p);
    return true;
  }
  // 3) 选中已有元素
  const pe = t.closest && t.closest('[data-pk]');
  if (pe){ psel = {kind: pe.dataset.pk, id: pe.dataset.pid}; renderPlanUI(); return true; }
  const rm = t.closest && t.closest('[data-room]');
  if (rm){ psel = {kind:'room', id: rm.dataset.room}; renderPlanUI(); return true; }
  const wl = t.closest && t.closest('[data-wall]');
  if (wl){ psel = {kind:'wall', id: wl.dataset.wall}; renderPlanUI(); return true; }
  // 4) 空白 → 取消选择，交给主脚本平移
  psel = null; renderPlanUI();
  return false;
}

function onPlanPointerMove(e){
  if (!planMode || !pdrag) return;
  const p = toMM(e);
  if (pdrag.kind === 'newroom' || pdrag.kind === 'newwall'){
    pdrag.b = snapPt(p);
    if (pdrag.kind === 'newwall') pdrag.shift = e.shiftKey;
    renderPlanOverlay();
    return;
  }
  if (pdrag.kind === 'handle'){
    const r = pdrag.rect, ph = pdrag.ph, MIN = 300;
    if (pdrag.pk === 'room'){
      if (ph.indexOf('w') >= 0) r.x0 = Math.min(p.x, r.x1-MIN);
      if (ph.indexOf('e') >= 0) r.x1 = Math.max(p.x, r.x0+MIN);
      if (ph.indexOf('n') >= 0) r.y0 = Math.min(p.y, r.y1-MIN);
      if (ph.indexOf('s') >= 0) r.y1 = Math.max(p.y, r.y0+MIN);
    } else {
      const horiz = (r.x1-r.x0) >= (r.y1-r.y0);
      if (ph === 'wl') r.x0 = Math.min(p.x, r.x1-100);
      if (ph === 'wr') r.x1 = Math.max(p.x, r.x0+100);
      if (ph === 'wt') r.y0 = Math.min(p.y, r.y1-100);
      if (ph === 'wb') r.y1 = Math.max(p.y, r.y0+100);
    }
    pdrag.next = clone(r);
    renderPlanOverlay();
  }
}

function onPlanPointerUp(e){
  if (!planMode || !pdrag) return;
  const d = pdrag; pdrag = null;
  if (d.kind === 'newroom'){
    const b = d.b || d.a;
    const r = {x0: Math.min(d.a.x,b.x), y0: Math.min(d.a.y,b.y), x1: Math.max(d.a.x,b.x), y1: Math.max(d.a.y,b.y)};
    if (r.x1-r.x0 >= 400 && r.y1-r.y0 >= 400){
      planMutate(() => { psel = {kind:'room', id: addRoom(r)}; }, true);
      toast(tr('已添加房间', 'Room added'));
    } else renderPlanOverlay();
    return;
  }
  if (d.kind === 'newwall'){
    const r = wallRectFrom(d.a, d.b || d.a, d.shift);
    if (r && (r.x1-r.x0 > 60 || r.y1-r.y0 > 60)){
      planMutate(() => { const i = WALLS.length; insertWall([r.x0, r.y0, r.x1, r.y1, 'n']); psel = {kind:'wall', id: wid(i)}; }, true);
      toast(tr('已添加墙体', 'Wall added'));
    } else renderPlanOverlay();
    return;
  }
  if (d.kind === 'handle' && d.next){
    if (JSON.stringify(d.orig) === JSON.stringify(d.next)){ renderPlanOverlay(); return; }
    planMutate(() => {
      if (d.pk === 'room') followWallsForRoom(d.pid, d.orig, d.next);
      setRect(d.pk, d.pid, d.next);
    }, true);
  }
}

function placeOpening(kind, p){
  const i = wallNear(p, 14/view.s);
  if (i < 0) return toast(tr('请点击在墙体上', 'Click on a wall'));
  const w = WALLS[i];
  const x0 = Math.min(w[0], w[2]), x1 = Math.max(w[0], w[2]);
  const y0 = Math.min(w[1], w[3]), y1 = Math.max(w[1], w[3]);
  const horiz = (x1-x0) >= (y1-y0);
  const span = horiz ? x1-x0 : y1-y0;
  const len = Math.max(400, Math.min(kind === 'win' ? 1500 : 800, span - 200));
  const c = horiz ? clamp(p.x, x0+len/2, x1-len/2) : clamp(p.y, y0+len/2, y1-len/2);
  const rect = horiz ? {x0:c-len/2, y0, x1:c+len/2, y1} : {x0, y0:c-len/2, x1, y1:c+len/2};
  if (kind === 'win'){
    planMutate(() => { psel = {kind:'win', id: addWin(rect, .9)}; }, true);
    toast(tr('已添加窗', 'Window added'));
  } else {
    const o = horiz ? (p.y < (y0+y1)/2 ? [0,-1] : [0,1]) : (p.x < (x0+x1)/2 ? [-1,0] : [1,0]);
    const cdir = horiz ? [1,0] : [0,1];
    planMutate(() => { psel = {kind:'door', id: addDoor(rect, o, cdir)}; }, true);
    toast(tr('已添加门', 'Door added'));
  }
}

/* =======================================================================
 *  右侧属性面板
 * ==================================================================== */
const WALL_TYPES = [
  ['n', '可拆非承重', 'Non-bearing'],
  ['b', '承重墙', 'Load-bearing'],
  ['e', '外墙', 'Exterior'],
  ['low', '矮墙', 'Low wall'],
];
function planPanelHtml(){
  if (!psel) return planOverviewHtml();
  if (psel.kind === 'room') return roomPropHtml(psel.id);
  if (psel.kind === 'wall') return wallPropHtml(psel.id);
  if (psel.kind === 'win')  return winPropHtml(psel.id);
  if (psel.kind === 'door') return doorPropHtml(psel.id);
  return planOverviewHtml();
}
function planOverviewHtml(){
  const rows = ROOMS.map(r => {
    const st = state.rooms[r.id] || {name:r.name, mat:r.mat};
    return `<tr class="click" data-pr="${r.id}"><td><span class="sw" style="background:${(MATS[st.mat]||MATS.tile800).sw}"></span>${esc(nm(st.name))}</td>
      <td class="r">${fmt(area(r.poly))} m²</td></tr>`;
  }).join('');
  return `
  ${planSeg === 'gen' ? `<section><h3>${tr('当前户型（将被覆盖）','Current plan (will be replaced)')}</h3>
    <div class="muted" style="font-size:12px">${tr('在左侧选好面积、形状和户型模板后点「生成户型」，当前户型会被整体替换（可用「撤销」回退）。',
      'Pick area, shape and layout on the left, then press Generate. The current plan is replaced (Undo restores it).')}</div></section>` : ''}
  <section><h3>${tr('户型总览','Floor Plan')} <small>${tr('点击房间可选中编辑','Click a room to edit')}</small></h3>
    <table>${rows || `<tr><td class="muted">${tr('暂无房间','No rooms')}</td></tr>`}</table>
    <div class="stats" style="margin-top:8px">
      <div><small>${tr('墙体','Walls')}</small><span class="big">${WALLS.length}</span></div>
      <div><small>${tr('窗 / 门','Win / Door')}</small><span class="big">${WINS.length} / ${DOORS.length}</span></div></div>
  </section>
  <section><h3>${tr('户型选项','Plan Options')}</h3>
    <label style="display:flex;gap:6px;align-items:center;cursor:pointer">
      <input type="checkbox" id="followRoom" ${followRoom?'checked':''}>${tr('房间改尺寸时贴合的墙体跟随','Move matching walls when a room is resized')}</label>
    <div class="actions">
      <button class="btn" id="pReset">${tr('重置为默认户型','Reset to default plan')}</button>
      <button class="btn" id="pExit">${tr('退出户型编辑','Exit plan editing')}</button></div></section>`;
}
function matPicker(cur){
  return Object.entries(MATS).map(([k,m]) =>
    `<button class="mat ${k===cur?'on':''}" data-mat="${k}"><i style="background:${m.sw}"></i><span>${nm(m.name)}<small>¥${m.price}/m²</small></span></button>`).join('');
}
function roomPropHtml(id){
  const r = roomOf(id); if (!r) return planOverviewHtml();
  const st = state.rooms[id] || {name:r.name, mat:r.mat};
  const rc = rectOf(r.poly);
  return `
  <section><h3>${tr('房间','Room')} <small>${tr('拖动手柄改尺寸','Drag handles to resize')}</small></h3>
    <div class="form"><label class="full">${tr('名称','Name')}<input id="prName" value="${esc(nm(st.name))}"></label></div>
    ${rc ? `<div class="stats" style="margin-top:10px">
      <div><small>${tr('开间','Width')}</small><span class="big">${Math.round(rc.x1-rc.x0)}</span> mm</div>
      <div><small>${tr('进深','Depth')}</small><span class="big">${Math.round(rc.y1-rc.y0)}</span> mm</div>
      <div><small>${tr('使用面积','Area')}</small><span class="big">${fmt(area(r.poly))}</span> m²</div>
      <div><small>${tr('周长','Perimeter')}</small><span class="big">${fmt(perim(r.poly),1)}</span> m</div></div>
      <div class="form" style="margin-top:10px">
        <label>${tr('开间','Width')} (mm)<input type="number" id="prW" value="${Math.round(rc.x1-rc.x0)}" step="50"></label>
        <label>${tr('进深','Depth')} (mm)<input type="number" id="prD" value="${Math.round(rc.y1-rc.y0)}" step="50"></label>
        <label>${tr('位置 X','X')} (mm)<input type="number" id="prX" value="${Math.round(rc.x0)}" step="50"></label>
        <label>${tr('位置 Y','Y')} (mm)<input type="number" id="prY" value="${Math.round(rc.y0)}" step="50"></label>
      </div>`
    : `<div class="muted" style="margin-top:8px">${tr('该房间不是矩形，只能整体移动；如需改尺寸请删除后重画。','This room is not a rectangle — it can only be moved. Delete and redraw to change its size.')}</div>
       <div class="form" style="margin-top:8px">
        <label>${tr('位置 X','X')} (mm)<input type="number" id="prX" value="${Math.round(r.poly[0][0])}" step="50"></label>
        <label>${tr('位置 Y','Y')} (mm)<input type="number" id="prY" value="${Math.round(r.poly[0][1])}" step="50"></label></div>`}
    <label style="display:flex;gap:6px;align-items:center;cursor:pointer;margin-top:8px">
      <input type="checkbox" id="prCounted" ${r.counted===false?'':'checked'}>${tr('计入套内使用面积','Count towards usable area')}</label>
  </section>
  <section><h3>${tr('地面材料','Flooring')}</h3><div class="mats">${matPicker(st.mat)}</div></section>
  <section><h3>${tr('操作','Actions')}</h3>
    <div class="actions"><button class="btn danger" id="prDel">${tr('删除房间','Delete room')}</button>
      <button class="btn" id="pBack">${tr('← 返回总览','← Back to overview')}</button></div></section>`;
}
function wallPropHtml(id){
  const w = wallOf(id); if (!w) return planOverviewHtml();
  const x0 = Math.min(w[0], w[2]), x1 = Math.max(w[0], w[2]);
  const y0 = Math.min(w[1], w[3]), y1 = Math.max(w[1], w[3]);
  const horiz = (x1-x0) >= (y1-y0);
  const len = horiz ? x1-x0 : y1-y0, th = horiz ? y1-y0 : x1-x0;
  const opts = WALL_TYPES.map(([k,zh,en]) =>
    `<option value="${k}" ${w[4]===k?'selected':''}>${tr(zh,en)}</option>`).join('');
  return `
  <section><h3>${tr('墙体','Wall')} <small>${tr('拖动端点改长度','Drag the ends to change length')}</small></h3>
    <div class="form">
      <label class="full">${tr('类型','Type')}<select id="pwType">${opts}</select></label>
      <label>${tr('长度','Length')} (mm)<input type="number" id="pwLen" value="${Math.round(len)}" step="50"></label>
      <label>${tr('厚度','Thickness')} (mm)<input type="number" id="pwTh" value="${Math.round(th)}" step="10"></label>
      <label>${tr('位置 X','X')} (mm)<input type="number" id="pwX" value="${Math.round(horiz?x0:x0)}" step="50"></label>
      <label>${tr('位置 Y','Y')} (mm)<input type="number" id="pwY" value="${Math.round(horiz?y0:y0)}" step="50"></label>
    </div>
    ${w[4]==='b' ? `<div class="muted" style="font-size:11px;margin-top:6px">${tr('承重墙不可在「拆改墙体」模式下拆除','Load-bearing walls cannot be removed in demolish mode')}</div>` : ''}
  </section>
  <section><h3>${tr('操作','Actions')}</h3>
    <div class="actions"><button class="btn danger" id="pwDel">${tr('删除墙体','Delete wall')}</button>
      <button class="btn" id="pBack">${tr('← 返回总览','← Back to overview')}</button></div></section>`;
}
function winPropHtml(id){
  const w = winOf(id); if (!w) return planOverviewHtml();
  const horiz = (w[2]-w[0]) >= (w[3]-w[1]);
  const len = horiz ? w[2]-w[0] : w[3]-w[1];
  return `
  <section><h3>${tr('窗','Window')}</h3>
    <div class="form">
      <label>${tr('长度','Length')} (mm)<input type="number" id="piLen" value="${Math.round(len)}" step="50"></label>
      <label>${tr('台高','Sill')} (m)<input type="number" id="piSill" value="${w[4]==null?.9:w[4]}" step="0.05" min="0" max="2"></label>
      <label>${tr('位置 X','X')} (mm)<input type="number" id="piX" value="${Math.round(w[0])}" step="50"></label>
      <label>${tr('位置 Y','Y')} (mm)<input type="number" id="piY" value="${Math.round(w[1])}" step="50"></label>
    </div>
  </section>
  <section><h3>${tr('操作','Actions')}</h3>
    <div class="actions"><button class="btn danger" id="piDel">${tr('删除窗','Delete window')}</button>
      <button class="btn" id="pBack">${tr('← 返回总览','← Back to overview')}</button></div></section>`;
}
function doorPropHtml(id){
  const d = doorOf(id); if (!d) return planOverviewHtml();
  return `
  <section><h3>${tr('门','Door')}</h3>
    <div class="form">
      <label>${tr('门宽','Width')} (mm)<input type="number" id="pdLen" value="${Math.round(d.len)}" step="50"></label>
      <label>${tr('位置 X','X')} (mm)<input type="number" id="pdX" value="${Math.round(d.rect[0])}" step="50"></label>
      <label>${tr('位置 Y','Y')} (mm)<input type="number" id="pdY" value="${Math.round(d.rect[1])}" step="50"></label>
    </div>
  </section>
  <section><h3>${tr('操作','Actions')}</h3>
    <div class="actions"><button class="btn danger" id="pdDel">${tr('删除门','Delete door')}</button>
      <button class="btn" id="pBack">${tr('← 返回总览','← Back to overview')}</button></div></section>`;
}

function bindPlanPanel(){
  const p = el('#panel');
  p.querySelectorAll('[data-pr]').forEach(tr => tr.onclick = () => { psel = {kind:'room', id: tr.dataset.pr}; renderPlanUI(); });
  const back = p.querySelector('#pBack'); if (back) back.onclick = () => { psel = null; renderPlanUI(); };
  const exit = p.querySelector('#pExit'); if (exit) exit.onclick = () => setPlanMode(false);
  const rst = p.querySelector('#pReset'); if (rst) rst.onclick = resetPlan;
  const fr = p.querySelector('#followRoom'); if (fr) fr.onchange = () => { followRoom = fr.checked; };
  const num = (sel, fn) => { const e2 = p.querySelector(sel); if (e2) e2.onchange = () => { const v = parseFloat(e2.value); if (!isNaN(v)) planMutate(() => fn(v), true); }; };

  if (psel && psel.kind === 'room'){
    const id = psel.id;
    const nEl = p.querySelector('#prName');
    if (nEl) nEl.onchange = e => planMutate(() => {
      const v = e.target.value.trim() || (state.rooms[id] && state.rooms[id].name);
      state.rooms[id].name = v;
      const r = roomOf(id); if (r) r.name = v;
    }, true);
    p.querySelectorAll('[data-mat]').forEach(b => b.onclick = () => planMutate(() => {
      state.rooms[id].mat = b.dataset.mat;
      const r = roomOf(id); if (r) r.mat = b.dataset.mat;
    }, true));
    num('#prW', v => resizeRoom(id, v, null));
    num('#prD', v => resizeRoom(id, null, v));
    num('#prX', v => moveRoom(id, v, null));
    num('#prY', v => moveRoom(id, null, v));
    const cd = p.querySelector('#prCounted');
    if (cd) cd.onchange = () => planMutate(() => { const r = roomOf(id); if (r) r.counted = cd.checked ? undefined : false; }, true);
    const del = p.querySelector('#prDel'); if (del) del.onclick = () => planMutate(() => removeRoom(id));
  }
  if (psel && psel.kind === 'wall'){
    const id = psel.id, i = +String(id).slice(1);
    const tp = p.querySelector('#pwType'); if (tp) tp.onchange = () => planMutate(() => { const w = wallOf(id); if (w) w[4] = tp.value; }, true);
    num('#pwLen', v => resizeWall(i, v, null));
    num('#pwTh',  v => resizeWall(i, null, v));
    num('#pwX',   v => moveWall(i, v, null));
    num('#pwY',   v => moveWall(i, null, v));
    const del = p.querySelector('#pwDel'); if (del) del.onclick = () => planMutate(() => removeWall(i));
  }
  if (psel && psel.kind === 'win'){
    const id = psel.id, i = +String(id).slice(1);
    num('#piLen',  v => resizeWin(i, v));
    num('#piSill', v => planMutate(() => { const w = winOf(id); if (w) w[4] = v; }, true));
    num('#piX',   v => moveWin(i, v, null));
    num('#piY',   v => moveWin(i, null, v));
    const del = p.querySelector('#piDel'); if (del) del.onclick = () => planMutate(() => removeWin(i));
  }
  if (psel && psel.kind === 'door'){
    const id = psel.id, i = +String(id).slice(1);
    num('#pdLen', v => resizeDoor(i, v));
    num('#pdX',  v => moveDoor(i, v, null));
    num('#pdY',  v => moveDoor(i, null, v));
    const del = p.querySelector('#pdDel'); if (del) del.onclick = () => planMutate(() => removeDoor(i));
  }
}

/* ---------------------------------------------- 数值编辑：房间 / 墙 / 门窗 */
function resizeRoom(id, w, d){
  const r = roomOf(id); if (!r) return;
  const rc = rectOf(r.poly); if (!rc) return;
  const before = clone(rc), after = clone(rc);
  if (w != null) after.x1 = after.x0 + Math.max(300, w);
  if (d != null) after.y1 = after.y0 + Math.max(300, d);
  followWallsForRoom(id, before, after);
  setRect('room', id, after);
}
function moveRoom(id, x, y){
  const r = roomOf(id); if (!r) return;
  const rc = rectOf(r.poly); if (!rc) return;
  const before = clone(rc), after = clone(rc);
  if (x != null){ const dx = x - rc.x0; after.x0 += dx; after.x1 += dx; }
  if (y != null){ const dy = y - rc.y0; after.y0 += dy; after.y1 += dy; }
  followWallsForRoom(id, before, after);
  setRect('room', id, after);
}
function resizeWall(i, len, th){
  const w = WALLS[i]; if (!w) return;
  const horiz = (Math.abs(w[2]-w[0]) >= Math.abs(w[3]-w[1]));
  const x0 = Math.min(w[0],w[2]), x1 = Math.max(w[0],w[2]), y0 = Math.min(w[1],w[3]), y1 = Math.max(w[1],w[3]);
  if (horiz){
    const L = len != null ? Math.max(100, len) : x1-x0;
    const T = th != null ? Math.max(60, th) : y1-y0;
    w[0] = x0; w[1] = y0; w[2] = x0+L; w[3] = y0+T;
  } else {
    const L = len != null ? Math.max(100, len) : y1-y0;
    const T = th != null ? Math.max(60, th) : x1-x0;
    w[0] = x0; w[1] = y0; w[2] = x0+T; w[3] = y0+L;
  }
}
function moveWall(i, x, y){
  const w = WALLS[i]; if (!w) return;
  const x0 = Math.min(w[0],w[2]), x1 = Math.max(w[0],w[2]), y0 = Math.min(w[1],w[3]), y1 = Math.max(w[1],w[3]);
  const dx = x != null ? x - x0 : 0, dy = y != null ? y - y0 : 0;
  w[0] = x0+dx; w[2] = x1+dx; w[1] = y0+dy; w[3] = y1+dy;
}
function resizeWin(i, len){
  const w = WINS[i]; if (!w) return;
  const horiz = (w[2]-w[0]) >= (w[3]-w[1]);
  const L = Math.max(200, len);
  if (horiz){ const cx = (w[0]+w[2])/2; w[0] = cx-L/2; w[2] = cx+L/2; }
  else { const cy = (w[1]+w[3])/2; w[1] = cy-L/2; w[3] = cy+L/2; }
}
function moveWin(i, x, y){
  const w = WINS[i]; if (!w) return;
  const dx = x != null ? x - w[0] : 0, dy = y != null ? y - w[1] : 0;
  w[0] += dx; w[2] += dx; w[1] += dy; w[3] += dy;
}
function resizeDoor(i, len){
  const d = DOORS[i]; if (!d) return;
  const horiz = (d.rect[2]-d.rect[0]) >= (d.rect[3]-d.rect[1]);
  const L = Math.max(300, len);
  if (horiz){
    const cx = (d.rect[0]+d.rect[2])/2;
    d.rect = [cx-L/2, d.rect[1], cx+L/2, d.rect[3]];
    d.h = [cx-L/2, (d.rect[1]+d.rect[3])/2]; d.len = L;
  } else {
    const cy = (d.rect[1]+d.rect[3])/2;
    d.rect = [d.rect[0], cy-L/2, d.rect[2], cy+L/2];
    d.h = [(d.rect[0]+d.rect[2])/2, cy-L/2]; d.len = L;
  }
}
function moveDoor(i, x, y){
  const d = DOORS[i]; if (!d) return;
  const dx = x != null ? x - d.rect[0] : 0, dy = y != null ? y - d.rect[1] : 0;
  d.rect = [d.rect[0]+dx, d.rect[1]+dy, d.rect[2]+dx, d.rect[3]+dy];
  d.h = [d.h[0]+dx, d.h[1]+dy];
}

/* ------------------------------------------------------------- 重置户型 */
function resetPlan(){
  if (!confirm(tr('确定把户型恢复为默认的三室两厅两卫吗？\n当前户型里的房间 / 墙体 / 门窗会一并还原（可撤销）。',
                  'Reset the floor plan to the default 3BR 2LR 2BA layout?\nAll rooms, walls, windows and doors will be restored (undoable).'))) return;
  planMutate(() => {
    state.plan = defaultPlan();
    state.rooms = {};
    DEFAULT_ROOMS.forEach(r => state.rooms[r.id] = {name:r.name, mat:r.mat});
    psel = null;
  });
  toast(tr('已恢复默认户型', 'Default floor plan restored'));
}

/* =======================================================================
 *  户型生成器（第二段）：按「面积 + 形状」生成一整套默认户型
 *
 *  做法：把矩形按「功能分带」切成若干横条，每条再按面积配额竖着切成房间，
 *  然后由房间边界反推墙体、窗与门 —— 这样房间和墙天然对得上，不会出现
 *  「房间改了、墙没跟上」的两套数据不一致。
 *
 *  模板里的每个 band 是一条横带，band 内从左到右排房间；相邻房间天然相邻，
 *  相邻 band 的房间天然上下相邻，房间门因此总能落在真实存在的墙上。
 * ==================================================================== */
const GEN_TEMPLATES = {
  '1r': {zh:'一室一厅一卫', en:'1 bed / 1 living / 1 bath', items:[
    ['客厅',.32],['餐厅',.11],['厨房',.10],['主卧',.28],['卫生间',.09],['玄关',.10]]},
  '2r': {zh:'两室两厅一卫', en:'2 bed / 2 living / 1 bath', items:[
    ['客厅',.26],['餐厅',.11],['厨房',.09],['主卧',.22],['次卧',.15],['卫生间',.08],['玄关',.09]]},
  '3r': {zh:'三室两厅两卫', en:'3 bed / 2 living / 2 bath', items:[
    ['客厅',.22],['餐厅',.10],['厨房',.08],['主卧',.17],['次卧',.12],['次卧',.12],['卫生间',.05],['卫生间',.05],['玄关',.09]]},
  '4r': {zh:'四室两厅两卫', en:'4 bed / 2 living / 2 bath', items:[
    ['客厅',.19],['餐厅',.09],['厨房',.07],['主卧',.16],['次卧',.11],['次卧',.11],['次卧',.11],['卫生间',.05],['卫生间',.05],['玄关',.06]]},
};
const GEN_RATIOS = [['square',1,'正方形','Square'],['r43',4/3,'长方形 4:3','Rectangle 4:3'],
                    ['r32',3/2,'长方形 3:2','Rectangle 3:2'],['r169',16/9,'长方形 16:9','Rectangle 16:9'],
                    ['r21',2,'长方形 2:1','Rectangle 2:1']];
const GEN_MATS = {主卧:'wood', 次卧:'wood', 客厅:'tile800', 餐厅:'tile800', 厨房:'tile600',
                  卫生间:'antislip', 玄关:'tile600'};

// 把矩形按面积配额递归二分（treemap 切片），得到长宽比较合理的房间矩形，
// 同时记录所有切分位置（= 内墙位置）
function genSlice(inner, items, T){
  const HALF = T/2, rooms = [], cuts = [];
  const rec = (r, list) => {
    if (!list.length) return;
    if (list.length === 1){ rooms.push({name:list[0][0], rect:r}); return; }
    const total = list.reduce((a,i)=>a+i[1], 0);
    let best = 1, bd = Infinity;
    for (let k = 1; k < list.length; k++){
      const a = list.slice(0,k).reduce((s,i)=>s+i[1],0)/total;
      if (Math.abs(a-.5) < bd){ bd = Math.abs(a-.5); best = k; }
    }
    const g1 = list.slice(0,best), g2 = list.slice(best);
    const q1 = g1.reduce((a,i)=>a+i[1],0), q2 = g2.reduce((a,i)=>a+i[1],0);
    const w = r.x1-r.x0, h = r.y1-r.y0;
    if (w >= h){                                   // 宽大于高 → 竖着切
      const cut = r.x0 + w*q1/(q1+q2);
      cuts.push({vert:true, pos:cut, a:r.y0, b:r.y1});
      rec({x0:r.x0, y0:r.y0, x1:cut-HALF, y1:r.y1}, g1);
      rec({x0:cut+HALF, y0:r.y0, x1:r.x1, y1:r.y1}, g2);
    } else {                                      // 高大于宽 → 横着切
      const cut = r.y0 + h*q1/(q1+q2);
      cuts.push({vert:false, pos:cut, a:r.x0, b:r.x1});
      rec({x0:r.x0, y0:r.y0, x1:r.x1, y1:cut-HALF}, g1);
      rec({x0:r.x0, y0:cut+HALF, x1:r.x1, y1:r.y1}, g2);
    }
  };
  rec(inner, items);
  return {rooms, cuts};
}

// 由房间矩形反推墙 / 窗 / 门，组装成一份完整的 plan
function assemblePlan(lay, inner, T){
  const HALF = T/2;
  const walls = [], wins = [], doors = [];
  // 外墙：套内矩形外扩一圈
  const IW = inner.x1-inner.x0, IH = inner.y1-inner.y0;
  walls.push([-T,-T, 0, IH+T,'e']);                       // 左
  walls.push([-T,-T, IW+T, 0,'e']);                      // 上
  walls.push([IW,-T, IW+T, IH+T,'e']);                   // 右
  walls.push([-T, IH, IW+T, IH+T,'e']);                  // 下
  // 内墙：每条切分线都是一道墙
  lay.cuts.forEach(c => {
    walls.push(c.vert ? [c.pos-HALF, c.a, c.pos+HALF, c.b, 'n'] : [c.a, c.pos-HALF, c.b, c.pos+HALF, 'n']);
  });
  // 房间
  const used = {};
  const rooms = lay.rooms.map((r, i) => {
    const base = r.name;
    used[base] = (used[base]||0) + 1;
    const n = used[base];
    const name = n > 1 ? base + ' ' + n : base;
    const mat = GEN_MATS[base] || 'tile800';
    const b = r.rect;
    return {id:'g'+i, name, mat, at:[(b.x0+b.x1)/2, (b.y0+b.y1)/2],
            poly:[[b.x0,b.y0],[b.x1,b.y0],[b.x1,b.y1],[b.x0,b.y1]]};
  });
  // 窗：贴着外墙的房间在外墙带上开窗
  const winLen = {主卧:1500, 次卧:1500, 客厅:2400, 餐厅:1500, 厨房:1200, 卫生间:600};
  rooms.forEach((r, i) => {
    const b = lay.rooms[i].rect, base = r.name.replace(/ \d+$/,'');
    if (base === '玄关') return;
    const L = winLen[base] || 1200, sill = base === '卫生间' ? 1.4 : .9;
    const put = (horiz, pos, a, bnd) => {
      const span = bnd - a, len = Math.min(L, Math.max(400, span - 400));
      const mid = (a+bnd)/2, s = mid-len/2, e = mid+len/2;
      wins.push(horiz ? [s, pos, e, pos+T, sill] : [pos, s, pos+T, e, sill]);
    };
    if (Math.abs(b.x0-inner.x0) < 1) put(false, inner.x0-T, b.y0, b.y1);
    if (Math.abs(b.x1-inner.x1) < 1) put(false, inner.x1, b.y0, b.y1);
    if (Math.abs(b.y0-inner.y0) < 1) put(true, inner.y0-T, b.x0, b.x1);
    if (Math.abs(b.y1-inner.y1) < 1) put(true, inner.y1, b.x0, b.x1);
  });
  // 内部门：相邻房间之间开门
  // 规则：卫生间之间、卧室之间、卧室↔卫生间、厨房↔卫生间/卧室都不开门；
  // 每个房间最多保留 2 扇内门；最后做连通性修复，保证每个房间都有门。
  const isBed = n => n === '主卧' || n === '次卧';
  const base = n => n.replace(/ \d+$/,'');
  const doorOK = (a, b) => {
    const ba = base(a), bb = base(b);
    if (ba === '卫生间' && bb === '卫生间') return false;
    if (isBed(ba) && isBed(bb)) return false;
    if (isBed(ba) && bb === '卫生间') return false;
    if (isBed(bb) && ba === '卫生间') return false;
    if (ba === '厨房' && (bb === '卫生间' || isBed(bb))) return false;
    if (bb === '厨房' && (ba === '卫生间' || isBed(ba))) return false;
    return true;
  };
  // 一对相邻房间之间的门位（几何上共用一道 240 的墙）
  const doorGeom = (i, j) => {
    const A = lay.rooms[i].rect, B = lay.rooms[j].rect;
    const vA = Math.abs(A.x1+T-B.x0) < 2, vB = Math.abs(B.x1+T-A.x0) < 2;
    const hA = Math.abs(A.y1+T-B.y0) < 2, hB = Math.abs(B.y1+T-A.y0) < 2;
    if (vA || vB){
      const left = vA ? A : B;
      const lo = Math.max(left.y0, (vA?B:A).y0), hi = Math.min(left.y1, (vA?B:A).y1);
      if (hi-lo <= 900) return null;
      const mid = (lo+hi)/2, h = Math.min(400, (hi-lo)/2-200);
      return {rect:[left.x1, mid-h, left.x1+T, mid+h], o:[-1,0]};
    }
    if (hA || hB){
      const top = hA ? A : B;
      const lo = Math.max(top.x0, (hA?B:A).x0), hi = Math.min(top.x1, (hA?B:A).x1);
      if (hi-lo <= 900) return null;
      const mid = (lo+hi)/2, h = Math.min(400, (hi-lo)/2-200);
      return {rect:[mid-h, top.y1, mid+h, top.y1+T], o:[0,-1]};
    }
    return null;
  };
  const cands = [];
  for (let i = 0; i < rooms.length; i++){
    for (let j = i+1; j < rooms.length; j++){
      if (!doorOK(rooms[i].name, rooms[j].name)) continue;
      const g = doorGeom(i, j);
      if (g) cands.push({i, j, rect:g.rect, o:g.o});
    }
  }
  // 每个房间最多 2 扇内门
  const cap = n => base(n) === '过道' ? 99 : 2;
  const cnt = {}, kept = [];
  cands.forEach(c => {
    if ((cnt[c.i]||0) >= cap(rooms[c.i].name) || (cnt[c.j]||0) >= cap(rooms[c.j].name)) return;
    cnt[c.i] = (cnt[c.i]||0)+1; cnt[c.j] = (cnt[c.j]||0)+1;
    kept.push(c);
  });
  // 连通性修复：还有房间没门 → 放宽规则强行接到一个已连通的相邻房间
  const adj = rooms.map(()=>[]);
  kept.forEach(c => { adj[c.i].push(c.j); adj[c.j].push(c.i); });
  const root = Math.max(0, rooms.findIndex(r => r.name === '玄关'));
  for (let pass = 0; pass < rooms.length; pass++){
    const seen = new Set([root]), stack = [root];
    while (stack.length){ const c = stack.pop(); adj[c].forEach(n => { if (!seen.has(n)){ seen.add(n); stack.push(n); } }); }
    let fixed = false;
    for (let i = 0; i < rooms.length && !fixed; i++){
      if (seen.has(i)) continue;
      let pick = null;
      for (let j = 0; j < rooms.length; j++){
        if (i === j || !seen.has(j)) continue;
        const g = doorGeom(i, j);
        if (!g) continue;
        const bn = base(rooms[j].name);
        if (!pick || bn === '客厅' || bn === '玄关') pick = {j, g};
        if (bn === '客厅') break;
      }
      if (pick){
        kept.push({i, j:pick.j, rect:pick.g.rect, o:pick.g.o});
        adj[i].push(pick.j); adj[pick.j].push(i);
        fixed = true;
      }
    }
    if (!fixed) break;
  }
  // 落地成 doors
  kept.forEach(c => {
    const x0 = c.rect[0], y0 = c.rect[1], x1 = c.rect[2], y1 = c.rect[3];
    const cx = (x0+x1)/2, cy = (y0+y1)/2;
    doors.push({name: tr('门','Door'), rect:[x0,y0,x1,y1],
                h: c.o[0] ? [x0, cy] : [cx, y0],
                c: c.o[0] ? [0,1] : [1,0], o: c.o,
                len: c.o[0] ? (y1-y0) : (x1-x0)});
  });
  // 入户门：玄关朝外墙开门
  const hIdx = rooms.findIndex(r => r.name === '玄关');
  if (hIdx >= 0){
    const b = lay.rooms[hIdx].rect;
    let d = null;
    if (Math.abs(b.y1-inner.y1) < 1){ const mid = (b.x0+b.x1)/2; d = {rect:[mid-450, inner.y1, mid+450, inner.y1+T], o:[0,-1]}; }
    else if (Math.abs(b.x0-inner.x0) < 1){ const mid = (b.y0+b.y1)/2; d = {rect:[inner.x0-T, mid-450, inner.x0, mid+450], o:[1,0]}; }
    else if (Math.abs(b.y0-inner.y0) < 1){ const mid = (b.x0+b.x1)/2; d = {rect:[mid-450, inner.y0-T, mid+450, inner.y0], o:[0,1]}; }
    else { const mid = (b.y0+b.y1)/2; d = {rect:[inner.x1, mid-450, inner.x1+T, mid+450], o:[-1,0]}; }
    const cx = (d.rect[0]+d.rect[2])/2, cy = (d.rect[1]+d.rect[3])/2;
    doors.push({name: tr('入户门','Entry door'), rect:d.rect,
                h: d.o[0] ? [d.rect[0], cy] : [cx, d.rect[1]],
                c: d.o[0] ? [0,1] : [1,0], o: d.o,
                len: d.o[0] ? (d.rect[3]-d.rect[1]) : (d.rect[2]-d.rect[0]), entry: true});
  }
  return {rooms, walls, wins, doors, slides: []};
}

function buildGeneratedPlan(areaM2, ratio, tplKey){
  const T = 240;
  const items = GEN_TEMPLATES[tplKey].items;
  const target = areaM2*1e6;
  let W = Math.sqrt(target*ratio), H = Math.sqrt(target/ratio);
  let inner = {x0:0, y0:0, x1:W, y1:H}, lay = null;
  for (let i = 0; i < 16; i++){
    lay = genSlice(inner, items, T);
    const usable = lay.rooms.reduce((a,r)=>a + (r.rect.x1-r.rect.x0)*(r.rect.y1-r.rect.y0), 0);
    if (!usable) break;
    const k = Math.sqrt(target/usable);
    if (Math.abs(k-1) < 0.0012) break;
    inner = {x0:0, y0:0, x1:inner.x1*k, y1:inner.y1*k};
  }
  return assemblePlan(lay, inner, T);
}

function generatePlan(){
  if (!confirm(tr('生成会覆盖当前户型（可用「撤销」回退），确定继续吗？',
                  'Generating replaces the current floor plan (Undo restores it). Continue?'))) return;
  planMutate(() => {
    state.plan = buildGeneratedPlan(genArea, genRatio, genTpl);
    psel = null;
  });
  planSeg = 'edit';
  paletteKey = '';
  renderPlanUI();
  toast(tr('已生成户型，切到「① 改房间」继续微调', 'Plan generated — switch to "① Edit rooms" to fine-tune'));
}


/* =======================================================================
 *  模式切换与 UI
 * ==================================================================== */
function segmentBarHtml(){
  const t = (seg, zh, en) => `<button class="seg-tab${planSeg===seg?' on':''}" data-seg="${seg}">${tr(zh,en)}</button>`;
  return `<div class="seg-tabs">
    ${t('edit','① 改房间','① Edit rooms')}
    ${t('gen','② 生成户型','② Generate plan')}
  </div>`;
}
function paletteHtml(){
  const b = (mode, zh, en, tipZh, tipEn) =>
    `<div class="item${addMode===mode?' on':''}" data-add="${mode}" title="${tr(tipZh, tipEn)}">
      <svg viewBox="0 0 56 44"><rect x="6" y="8" width="44" height="28" rx="3" fill="none" stroke="#3d3a34" stroke-width="2"/></svg>
      <b>${tr(zh, en)}</b><small>${tr(tipZh, tipEn)}</small></div>`;
  return `
  <h4>${tr('户型元素 · 点选后在平面上操作','Plan elements · click, then use the plan')}</h4>
  <div class="lib-grid">
    ${b('room','房间','Room','拖出矩形新建房间','Drag a rectangle to create a room')}
    ${b('wall','墙体','Wall','拖出线段新建墙体','Drag a line to create a wall')}
    ${b('win','窗','Window','点击墙体开窗','Click a wall to add a window')}
    ${b('door','门','Door','点击墙体开门','Click a wall to add a door')}
  </div>
  <div class="hint">${tr(
    '· 先点上面的元素，再在平面图上拖动 / 点击；Esc 退出当前工具。<br>· 直接点平面图上的房间、墙体、窗、门即可选中，在右侧属性面板里改尺寸。<br>· 房间的角点 / 边中点手柄可拖动改尺寸，墙体两端手柄可改长度。<br>· 改动会随方案一起保存，可用「撤销」回退。',
    '· Pick an element above, then drag / click on the plan; Esc cancels the tool.<br>· Click a room, wall, window or door on the plan to select it and edit its size in the properties panel.<br>· Drag the corner / edge handles of a room to resize, or the end handles of a wall to change its length.<br>· Changes are saved with the plan and can be undone.')}</div>
  <div class="actions" style="padding:0 10px 14px">
    <button class="btn" id="pReset2">${tr('重置为默认户型','Reset to default plan')}</button></div>`;
}
function genPaletteHtml(){
  const ratioBtns = GEN_RATIOS.map(([k,r,zh,en]) =>
    `<button class="btn chip${genRatio===r?' on':''}" data-ratio="${r}" style="margin:0 4px 6px 0">${tr(zh,en)}</button>`).join('');
  const tplBtns = Object.entries(GEN_TEMPLATES).map(([k,t]) =>
    `<button class="btn chip${genTpl===k?' on':''}" data-tpl="${k}" style="margin:0 4px 6px 0">${tr(t.zh,t.en)}</button>`).join('');
  return `
  <h4>${tr('生成户型 · 选面积和形状','Generate a plan · pick area & shape')}</h4>
  <div style="padding:4px 12px 0">
    <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px">
      ${tr('套内使用面积','Usable floor area')} <b id="genAreaVal" style="color:var(--ink)">${genArea}</b> m²</label>
    <input type="range" id="genArea" min="40" max="160" step="1" value="${genArea}" style="width:100%">
    <div style="font-size:11px;color:var(--muted);margin:6px 0 2px">${tr('外形','Shape')}</div>
    <div>${ratioBtns}</div>
    <div style="font-size:11px;color:var(--muted);margin:6px 0 2px">${tr('户型','Layout')}</div>
    <div>${tplBtns}</div>
    <div class="actions" style="margin-top:10px">
      <button class="btn primary" id="genGo">${tr('生成户型','Generate')}</button>
    </div>
    <div class="hint" style="padding:6px 0 14px">${tr(
      '生成会按「功能分带 + 面积配额」把矩形切成房间，并自动配上外墙、内墙、窗与门，房间和墙天然对得上。<br>会覆盖当前户型（可用「撤销」回退），生成后再回到「① 改房间」继续微调。',
      'The rectangle is cut into rooms by zone bands and area quotas, then walls, windows and doors are derived from the room boundaries, so rooms and walls always match.<br>This replaces the current plan (Undo restores it); switch back to "① Edit rooms" to fine-tune.')}</div>
  </div>`;
}


function renderLeftPanel(){
  const lib = el('#lib');
  if (!lib) return;
  const want = planMode && !is3d();          // 3D 下左侧仍是家具库，方便在 3D 里摆家具
  if (want){
    const key = 'palette|' + planSeg + '|' + addMode + '|' + genRatio + '|' + genTpl;
    if (lib.dataset.mode !== 'palette' || paletteKey !== key){
      lib.dataset.mode = 'palette'; paletteKey = key;
      lib.innerHTML = segmentBarHtml() + (planSeg === 'gen' ? genPaletteHtml() : paletteHtml());
      bindPalette();
    }
  } else if (lib.dataset.mode === 'palette'){
    delete lib.dataset.mode; paletteKey = '';
    buildLib();
  }
}
function bindPalette(){
  const lib = el('#lib');
  if (!lib) return;
  lib.querySelectorAll('[data-seg]').forEach(b => b.onclick = () => {
    planSeg = b.dataset.seg; addMode = null; psel = null; paletteKey = '';
    renderPlanUI(); syncPlanHint();
  });
  lib.querySelectorAll('[data-add]').forEach(it => it.onclick = () => {
    addMode = addMode === it.dataset.add ? null : it.dataset.add;
    psel = null;
    renderPlanUI();
    syncPlanHint();
  });
  lib.querySelectorAll('[data-ratio]').forEach(b => b.onclick = () => { genRatio = Number(b.dataset.ratio); renderPlanUI(); });
  lib.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => { genTpl = b.dataset.tpl; renderPlanUI(); });
  const ar = lib.querySelector('#genArea');
  if (ar) ar.oninput = () => {
    genArea = Number(ar.value);
    const v = lib.querySelector('#genAreaVal'); if (v) v.textContent = genArea;
  };
  const go = lib.querySelector('#genGo'); if (go) go.onclick = generatePlan;
  const r2 = lib.querySelector('#pReset2'); if (r2) r2.onclick = resetPlan;
}

function renderPlanUI(){
  renderLeftPanel();
  if (planMode){
    el('#panel').innerHTML = planPanelHtml();
    bindPlanPanel();
    el('#fab').classList.remove('show');
  } else {
    renderPanel();                             // 让主脚本画回它自己的面板
  }
  const tg = el('#tgPlan');
  if (tg) tg.classList.toggle('on', planMode);
  if (planMode && !is3d()) renderPlanOverlay();
}

function syncPlanHint(){
  const h = el('#modehint');
  if (!h) return;
  let txt = '';
  if (planSeg === 'gen') txt = tr('在左侧选择面积、形状和户型模板，点「生成户型」即可得到一整套户型 · P 退出户型编辑',
    'Choose area, shape and layout on the left, then press Generate · P exits');
  else if (addMode === 'room') txt = tr('拖出一个矩形新建房间 · Esc 取消','Drag a rectangle to create a room · Esc cancels');
  else if (addMode === 'wall') txt = tr('拖出一条线新建墙体（自动对齐水平 / 垂直，Shift 反向）· Esc 取消','Drag to create a wall (auto axis-aligned, Shift reverses) · Esc cancels');
  else if (addMode === 'win') txt = tr('点击一段墙体开窗 · Esc 取消','Click a wall to add a window · Esc cancels');
  else if (addMode === 'door') txt = tr('点击一段墙体开门 · Esc 取消','Click a wall to add a door · Esc cancels');
  else txt = tr('点击房间 / 墙体 / 窗 / 门选中后编辑；左侧可添加元素 · P 退出户型编辑','Click a room, wall, window or door to edit; use the palette on the left to add · P exits');
  h.textContent = txt;
  h.classList.toggle('show', planMode && !is3d());
}

function setPlanMode(on){
  if (planMode === on) return;
  planMode = on;
  addMode = null; psel = null; pdrag = null;
  document.body.classList.toggle('planmode', on);
  paletteKey = '';
  _setTool(on ? 'plan' : 'select');
  renderPlanUI();
  syncPlanHint();
  if (!on) el('#modehint').classList.remove('show');
}

/* =======================================================================
 *  与主脚本对接
 * ==================================================================== */
let _setTool = null;
function install(){
  // 注入户型编辑器专用样式（分段切换条）
  if (!el('#planEditorStyle')){
    const st = document.createElement('style');
    st.id = 'planEditorStyle';
    st.textContent = `.seg-tabs{display:flex;gap:4px;padding:10px 10px 2px}
      .seg-tab{flex:1;border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 4px;
        cursor:pointer;font-size:12px;color:var(--muted);white-space:nowrap}
      .seg-tab:hover{background:#f2ece2}
      .seg-tab.on{background:var(--accent);border-color:var(--accent);color:#fff}`;
    document.head.appendChild(st);
  }
  // 顶栏加一个「户型」按钮
  const tools = el('#tools');
  if (tools && !el('#tgPlan')){
    const grp = document.createElement('div');
    grp.className = 'grp';
    grp.innerHTML = `<button class="btn chip" id="tgPlan" title="${tr('编辑户型（房间 / 墙体 / 门窗）','Edit the floor plan (rooms / walls / openings)')}">${tr('户型','Plan')}</button>`;
    tools.parentNode.insertBefore(grp, tools.nextSibling);
    el('#tgPlan').onclick = () => setPlanMode(!planMode);
  }
  // 指针接管：主脚本 pointerdown 第一行调用 PLAN_HOOK，返回 true 即接管
  window.PLAN_HOOK = onPlanPointerDown;
  svgEl().addEventListener('pointermove', onPlanPointerMove);
  svgEl().addEventListener('pointerup', onPlanPointerUp);
  svgEl().addEventListener('pointercancel', onPlanPointerUp);

  // 渲染 / 面板挂接
  const _renderSel = renderSel;
  renderSel = function(){ _renderSel(); if (planMode) renderPlanOverlay(); };
  const _renderPanel = renderPanel;
  renderPanel = function(){
    if (planMode){ el('#panel').innerHTML = planPanelHtml(); bindPlanPanel(); el('#fab').classList.remove('show'); return; }
    _renderPanel();
  };
  const _renderAll = renderAll;
  renderAll = function(){ _renderAll(); if (planMode) renderPlanUI(); };
  // 户型模式下屏蔽主脚本的选中（家具等），避免两套选中打架
  const _select = select;
  select = function(sel){ if (planMode) return; _select(sel); };
  // 户型模式下工具保持 plan，避免主脚本把工具切回 select 后误触发选中
  const _st = setTool;
  _setTool = _st;
  setTool = function(t){ _st(planMode ? 'plan' : t); };
  // 2D / 3D 切换后重画左侧面板（3D 下用家具库，2D 下用户型元素面板）。
  // 主脚本的 setView 是异步的，但 body 的 m3d class 是同步切换的，
  // 所以先调用它（拿到同步部分），再立刻刷新面板，不用等切换动画。
  const _setView = setView;
  setView = function(m){
    const pr = _setView(m);
    renderPlanUI();
    return pr;
  };
  // 点主工具栏的「选择 / 测量 / 拆改墙体」＝退出户型模式
  document.querySelectorAll('#tools .btn').forEach(b => {
    const orig = b.onclick;
    b.onclick = e => { if (planMode) setPlanMode(false); if (orig) orig(e); };
  });

  // 键盘：P 进出户型模式，Esc 退出添加工具 / 取消选择
  document.addEventListener('keydown', e => {
    if (e.target.matches && e.target.matches('input,select,textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey){ setPlanMode(!planMode); e.preventDefault(); return; }
    if (!planMode) return;
    if (e.key === 'Escape'){
      if (addMode){ addMode = null; renderPlanUI(); syncPlanHint(); }
      else if (psel){ psel = null; renderPlanUI(); }
      else setPlanMode(false);
      e.preventDefault();
    }
  });
  window.addEventListener('resize', () => { if (planMode) renderPlanOverlay(); });
}

if (document.readyState === 'complete' || document.readyState === 'interactive') install();
else document.addEventListener('DOMContentLoaded', install);

})();
