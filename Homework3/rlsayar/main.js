// ============================================================
// Pokémon Stats Dashboard — main.js
// ECS 163 Homework 3  |  rlsayar
//
// Three interactions + a meaningful animated transition:
//
//   INTERACTION 1 — Selection (click a dot or PCP line)
//     Click a scatter dot or PCP line to single-select; cross-highlights
//     across all three views.  Click again to deselect.
//
//   INTERACTION 2 — Brushing (d3.brush on scatter, Individual mode)
//     Drag a rectangle over dots to select a subset.  The bar chart
//     overlays solid colored bars (selected count) on top of faded
//     bars (total count) so the share is visually obvious.  PCP dims
//     non-matching polylines.
//
//   TRANSITION — Visualization Change / Filtering (≈800 ms ease-cubic)
//     Switching scatter/PCP mode does NOT clear and redraw.  Each
//     individual Pokémon dot/line is persistent and animates from
//     its individual position to its group's centroid:
//        Individual → Type Avg    : each dot moves to its type's centroid
//        Individual → K-Means     : each dot moves to its cluster's centroid
//     This makes the grouping itself the focus of the animation —
//     you literally see which Pokémon get fit into which category.
//     Group decorations (type labels, cluster rings) fade in/out as
//     dots arrive.  Same idea is mirrored in the PCP for polylines.
//
// All three views share one type-color palette and a clickable
// legend that filters every view simultaneously with a smooth fade.
// ============================================================

// ── Shared type color palette ────────────────────────────────
const TYPE_COLORS = {
  Normal:   '#A8A77A', Fire:     '#EE8130', Water:    '#6390F0',
  Electric: '#F7D02C', Grass:    '#7AC74C', Ice:      '#96D9D6',
  Fighting: '#C22E28', Poison:   '#A33EA1', Ground:   '#E2BF65',
  Flying:   '#A98FF3', Psychic:  '#F95587', Bug:      '#A6B91A',
  Rock:     '#B6A136', Ghost:    '#735797', Dragon:   '#6F35FC',
  Dark:     '#705746', Steel:    '#B7B7CE', Fairy:    '#D685AD'
};
function typeColor(t) { return TYPE_COLORS[t] ?? '#999'; }
const ALL_TYPES = Object.keys(TYPE_COLORS);

const STAT_KEYS   = ['hp', 'attack', 'defense', 'spAtk', 'spDef', 'speed'];
const STAT_LABELS = ['HP', 'Attack', 'Defense', 'Sp.Atk', 'Sp.Def', 'Speed'];
const CLUSTER_COLORS = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00'];

const MORPH_MS = 800;   // mode-morph animation duration
const FADE_MS  = 250;   // filter/selection fade duration

function dims(id) {
  const el = document.getElementById(id);
  const r  = el.getBoundingClientRect();
  return { w: r.width || el.offsetWidth, h: r.height || el.offsetHeight };
}

// ── Global state ──────────────────────────────────────────────
const activeTypes = new Set(ALL_TYPES);
let scatterMode = 'all';
let pcpMode     = 'type';
let pokemonData = [];
let nameToType1 = new Map();
let brushedNames = null;        // Set<string> | null
let selectedName = null;        // string | null
const updaters = { bar: null, scatter: null, pcp: null };

// Mode-morph callbacks exposed by drawScatter / drawPCP so that
// setScatterMode / setPCPMode can animate instead of redrawing.
let scatterApplyMode = null;
let pcpApplyMode     = null;

function clearInteractions() {
  brushedNames = null;
  selectedName = null;
}

// ── Global type toggle ────────────────────────────────────────
function toggleType(type, itemG) {
  if (activeTypes.has(type)) {
    activeTypes.delete(type);
    itemG.classed('inactive', true);
  } else {
    activeTypes.add(type);
    itemG.classed('inactive', false);
  }
  if (updaters.bar)     updaters.bar();
  if (updaters.scatter) updaters.scatter();
  if (updaters.pcp)     updaters.pcp();
}

// ── Mode switches — ANIMATE, do not redraw ───────────────────
function setScatterMode(mode) {
  scatterMode = mode;
  document.querySelectorAll('#scatter-controls .toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  // Clearing brush is part of the morph (dots are moving)
  brushedNames = null;
  if (scatterApplyMode) scatterApplyMode();
  if (updaters.bar) updaters.bar();
  if (updaters.pcp) updaters.pcp();
}

function setPCPMode(mode) {
  pcpMode = mode;
  document.querySelectorAll('#pcp-controls .toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  if (pcpApplyMode) pcpApplyMode();
}

// ── K-Means clustering ────────────────────────────────────────
function kMeans(data, k, maxIter = 80) {
  const ranges = STAT_KEYS.map(key => ({
    min: d3.min(data, d => d[key]),
    max: d3.max(data, d => d[key])
  }));
  const norm = (val, i) =>
    (val - ranges[i].min) / Math.max(ranges[i].max - ranges[i].min, 1);

  const pts = data.map(d => STAT_KEYS.map((key, i) => norm(d[key], i)));
  let cents = Array.from({ length: k }, (_, ci) =>
    [...pts[Math.floor((ci / k) * pts.length)]]
  );
  let labels = new Array(pts.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    pts.forEach((p, i) => {
      let best = 0, bestD = Infinity;
      cents.forEach((c, j) => {
        const d2 = p.reduce((s, v, di) => s + (v - c[di]) ** 2, 0);
        if (d2 < bestD) { bestD = d2; best = j; }
      });
      if (labels[i] !== best) { changed = true; labels[i] = best; }
    });
    if (!changed) break;
    cents = cents.map((prev, ci) => {
      const members = pts.filter((_, i) => labels[i] === ci);
      if (!members.length) return prev;
      return STAT_KEYS.map((_, di) => d3.mean(members, p => p[di]));
    });
  }

  const statName = {
    hp: 'Bulky', attack: 'Physical Atk', defense: 'Physical Wall',
    spAtk: 'Special Atk', spDef: 'Special Wall', speed: 'Swift'
  };

  const centroids = cents.map((c, ci) => {
    const stats = Object.fromEntries(
      STAT_KEYS.map((key, i) => [key, c[i] * (ranges[i].max - ranges[i].min) + ranges[i].min])
    );
    const top = STAT_KEYS.reduce((a, b) => stats[a] > stats[b] ? a : b);
    const members = data.filter((_, i) => labels[i] === ci);
    const tc = d3.rollup(members, v => v.length, d => d.type1);
    return {
      cluster: ci, count: members.length,
      name: `C${ci + 1}: ${statName[top]}`,
      topTypes: Array.from(tc, ([t, n]) => ({ t, n })).sort((a, b) => b.n - a.n).slice(0, 4),
      ...stats
    };
  });

  return { centroids, labels };
}

// ── Redraw all views (only on initial load and resize) ────────
function redrawAll() {
  clearInteractions();
  document.getElementById('bar-chart').innerHTML    = '';
  document.getElementById('scatter-plot').innerHTML = '';
  document.getElementById('pcp-chart').innerHTML    = '';
  d3.selectAll('.tooltip').remove();
  drawBarChart(pokemonData);
  drawScatter(pokemonData);
  drawPCP(pokemonData);
}

// ── Load data ─────────────────────────────────────────────────
d3.csv('data/pokemon.csv', r => ({
  id:         +r.ID,         name:   r.Name,
  form:        r.Form.trim(), type1:  r.Type1,  type2: r.Type2.trim(),
  total:      +r.Total,
  hp:         +r.HP,         attack: +r.Attack, defense: +r.Defense,
  spAtk:      +r['Sp. Atk'], spDef:  +r['Sp. Def'], speed: +r.Speed,
  generation: +r.Generation,
  // Composite axes: offence = Attack + Sp.Atk, defence = HP + Defense + Sp.Def
  offence: +r.Attack + +r['Sp. Atk'],
  defence: +r.HP     + +r.Defense   + +r['Sp. Def']
})).then(raw => {
  const seen = new Set();
  pokemonData = raw.filter(d => { if (seen.has(d.name)) return false; seen.add(d.name); return true; });
  nameToType1 = new Map(pokemonData.map(d => [d.name, d.type1]));
  // Call directly (rAF can be throttled when the preview panel isn't focused)
  redrawAll();
});

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redrawAll, 150); });

// ─────────────────────────────────────────────────────────────
// View 1 — Bar Chart (Context / Overview)
//
// New brush display: two layers of bars.
//   Background bars (always present): full width = total per type, faded
//     to ~0.22 opacity when a brush is active.
//   Selection bars (overlaid):  width = count of brushed Pokémon for
//     that type, full color.  Labels switch to "selected / total".
// ─────────────────────────────────────────────────────────────
function drawBarChart(data) {
  const { w: W, h: H } = dims('bar-chart');
  const m  = { top: 8, right: 48, bottom: 32, left: 88 };
  const iW = W - m.left - m.right;
  const iH = H - m.top  - m.bottom;

  const svg = d3.select('#bar-chart').append('svg').attr('width', W).attr('height', H);
  const g   = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  const counts = Array.from(
    d3.rollup(data, v => v.length, d => d.type1),
    ([type, count]) => ({ type, count })
  ).sort((a, b) => b.count - a.count);

  const yScale = d3.scaleBand().domain(counts.map(d => d.type)).range([0, iH]).padding(0.22);
  const xScale = d3.scaleLinear().domain([0, d3.max(counts, d => d.count)]).range([0, iW]).nice();

  // Vertical grid lines
  g.selectAll('.x-grid').data(xScale.ticks(5)).join('line')
    .attr('class', 'x-grid')
    .attr('x1', d => xScale(d)).attr('x2', d => xScale(d))
    .attr('y1', 0).attr('y2', iH)
    .attr('stroke', '#eee').attr('stroke-dasharray', '3,3');

  // BACKGROUND bars (always at full width = total count)
  const bgBars = g.selectAll('.bg-bar').data(counts).join('rect')
    .attr('class', 'bg-bar')
    .attr('x', 0).attr('y', d => yScale(d.type))
    .attr('width', d => xScale(d.count))
    .attr('height', yScale.bandwidth())
    .attr('fill', d => typeColor(d.type)).attr('rx', 3);

  // SELECTION OVERLAY bars (initially width 0, grow when brush active)
  const selBars = g.selectAll('.sel-bar').data(counts).join('rect')
    .attr('class', 'sel-bar')
    .attr('x', 0).attr('y', d => yScale(d.type))
    .attr('width', 0)
    .attr('height', yScale.bandwidth())
    .attr('fill', d => typeColor(d.type)).attr('rx', 3)
    .attr('opacity', 0);

  const barLabels = g.selectAll('.bar-label').data(counts).join('text')
    .attr('class', 'bar-label')
    .attr('x', d => xScale(d.count) + 4)
    .attr('y', d => yScale(d.type) + yScale.bandwidth() / 2)
    .attr('dy', '0.35em').attr('fill', '#555').attr('font-size', '11px')
    .text(d => d.count);

  const yAxis = g.append('g').attr('class', 'axis y-axis')
    .call(d3.axisLeft(yScale).tickSize(0).tickPadding(6))
    .call(a => a.select('.domain').remove());
  yAxis.selectAll('text').attr('fill', '#333').attr('font-size', '11px').attr('font-weight', '600');

  g.append('g').attr('class', 'axis x-axis')
    .attr('transform', `translate(0,${iH})`)
    .call(d3.axisBottom(xScale).ticks(5))
    .call(a => a.select('.domain').attr('stroke', '#ccc'))
    .selectAll('text').attr('fill', '#555');

  g.append('text').attr('class', 'axis-label')
    .attr('x', iW / 2).attr('y', iH + 28)
    .attr('text-anchor', 'middle').attr('fill', '#777').attr('font-size', '11px')
    .text('Number of Pokémon (base forms only)');

  // ── Update logic ──────────────────────────────────────────
  updaters.bar = () => {
    // Count brushed Pokémon per type
    let brushedCounts = null;
    if (brushedNames !== null) {
      brushedCounts = new Map();
      brushedNames.forEach(n => {
        const t = nameToType1.get(n);
        brushedCounts.set(t, (brushedCounts.get(t) || 0) + 1);
      });
    }
    const selType = selectedName ? nameToType1.get(selectedName) : null;

    bgBars.transition().duration(FADE_MS).attr('opacity', d => {
      if (!activeTypes.has(d.type)) return 0.07;
      if (brushedCounts) return 0.22;                    // brush active → fade
      if (selType) return d.type === selType ? 1 : 0.18; // single selection
      return 1;
    });

    selBars.transition().duration(FADE_MS)
      .attr('opacity', d => brushedCounts && activeTypes.has(d.type) ? 1 : 0)
      .attr('width', d => brushedCounts ? xScale(brushedCounts.get(d.type) || 0) : 0);

    barLabels.transition().duration(FADE_MS)
      .attr('opacity', d => activeTypes.has(d.type) ? 1 : 0)
      .attr('x', d => {
        const w = brushedCounts ? Math.max(xScale(brushedCounts.get(d.type) || 0), xScale(d.count)) : xScale(d.count);
        return w + 4;
      })
      .text(d => {
        if (!brushedCounts) return d.count;
        const sel = brushedCounts.get(d.type) || 0;
        return `${sel} / ${d.count}`;
      });

    yAxis.selectAll('.tick').transition().duration(FADE_MS)
      .attr('opacity', d => activeTypes.has(d) ? 1 : 0.15);
  };
}

// ─────────────────────────────────────────────────────────────
// View 2 — Attack vs Defense Scatter (Focus)
//
// Persistent dots — one per Pokémon — that animate between modes.
// 'all'    : individual (attack, defense) positions
// 'type'   : each dot moves to its primary type's average position
// 'kmeans' : each dot moves to its k-means cluster's centroid position
//
// The morph itself IS the insight: you see Bulbasaur, Charmander and
// Squirtle all sliding to different type centroids, or every member of
// "Cluster 3: Special Atk" converging into one ball.
// ─────────────────────────────────────────────────────────────
function drawScatter(data) {
  const { w: W, h: H } = dims('scatter-plot');
  const m  = { top: 10, right: 152, bottom: 46, left: 52 };
  const iW = W - m.left - m.right;
  const iH = H - m.top  - m.bottom;

  const tip = d3.select('body')
    .selectAll('.tooltip').data([null]).join('div')
    .attr('class', 'tooltip').style('opacity', 0);

  const svg = d3.select('#scatter-plot').append('svg').attr('width', W).attr('height', H);
  const g   = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  // Composite axes: offence = Attack + Sp.Atk  |  defence = HP + Defense + Sp.Def
  const baseXScale = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.offence) + 20]).range([0, iW]);
  const baseYScale = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.defence) + 20]).range([iH, 0]);
  const rScale = d3.scaleSqrt()
    .domain(d3.extent(data, d => d.total)).range([2.5, 9]);

  // Current zoom transform (mutated by d3.zoom)
  let currentTransform = d3.zoomIdentity;
  let xScale = baseXScale;   // current (possibly rescaled) x
  let yScale = baseYScale;   // current (possibly rescaled) y

  // Pre-compute targets for every mode (so morph is instant)
  const typeAvgsMap = new Map();
  d3.rollup(data, v => ({
    type:    v[0].type1, count: v.length,
    attack:  d3.mean(v, d => d.attack),
    defense: d3.mean(v, d => d.defense),
    offence: d3.mean(v, d => d.offence),
    defence: d3.mean(v, d => d.defence),
    total:   d3.mean(v, d => d.total)
  }), d => d.type1).forEach((v, k) => typeAvgsMap.set(k, v));
  const typeAvgsArr = [...typeAvgsMap.values()];

  const { centroids, labels } = kMeans(data, 5);
  // Add composite values to k-means centroids
  centroids.forEach((c, ci) => {
    const members = data.filter((_, i) => labels[i] === ci);
    c.offence = d3.mean(members, d => d.offence);
    c.defence = d3.mean(members, d => d.defence);
  });
  const countScale = d3.scaleSqrt()
    .domain([0, d3.max(centroids, d => d.count)]).range([14, 30]);

  // Data-space position for a dot (uses composite offence/defence axes)
  function dataPos(d, i, mode) {
    if (mode === 'all')  return { a: d.offence, e: d.defence };
    if (mode === 'type') { const a = typeAvgsMap.get(d.type1); return { a: a.offence, e: a.defence }; }
    const c = centroids[labels[i]];
    return { a: c.offence, e: c.defence };
  }
  function rFor(d, i, mode) {
    if (mode === 'all') return rScale(d.total);
    if (mode === 'type') return rScale(d.total) * 0.7;
    return rScale(d.total) * 0.6;
  }
  function defaultOp(mode) {
    if (mode === 'all') return 0.65;
    if (mode === 'type') return 0.12;   // hull mode: dots are just faint context
    return 0.18;
  }

  // Balanced reference diagonal: defence = offence + meanHP
  // Defence has 3 stats (HP + Def + SpDef); offence has 2 (Atk + SpAtk).
  // A "balanced" Pokémon has defence ≈ offence + meanHP, so we shift the
  // diagonal up by the average HP so the reference is meaningful.
  const meanHP   = d3.mean(data, d => d.hp);
  const diagEndX = Math.min(d3.max(data, d => d.offence), d3.max(data, d => d.defence) - meanHP);
  const atkDefLine = g.append('line').attr('class', 'atk-def-line')
    .attr('x1', xScale(0)).attr('y1', yScale(meanHP))
    .attr('x2', xScale(diagEndX)).attr('y2', yScale(diagEndX + meanHP))
    .attr('stroke', '#ccc').attr('stroke-dasharray', '5,4').attr('stroke-width', 1);
  const atkDefLabel = g.append('text').attr('class', 'atk-def-label')
    .attr('x', xScale(diagEndX) - 4).attr('y', yScale(diagEndX + meanHP) - 6)
    .attr('fill', '#aaa').attr('font-size', '10px').attr('text-anchor', 'end')
    .text('Balanced (offence ≈ defence)');

  // ── OUTLIER LABELS (Individual mode only — hidden in other modes) ──
  const maxAtk = d3.max(data, d => d.offence);
  const maxDef = d3.max(data, d => d.defence);
  const topByAtk = [...data].sort((a,b) => b.offence - a.offence).slice(0, 5);
  const topByDef = [...data].sort((a,b) => b.defence - a.defence).slice(0, 5);
  const outlierSet = new Map();
  [...topByAtk, ...topByDef].forEach(d => { if (!outlierSet.has(d.name)) outlierSet.set(d.name, d); });
  const outlierG = g.append('g').attr('class', 'outlier-layer')
    .style('display', scatterMode === 'all' ? null : 'none');
  outlierSet.forEach(d => {
    outlierG.append('text')
      .attr('class', 'outlier-label')
      .attr('x', baseXScale(d.offence) + (d.offence > maxAtk * 0.7 ? -4 : 6))
      .attr('y', baseYScale(d.defence) + 3)
      .attr('text-anchor', d.offence > maxAtk * 0.7 ? 'end' : 'start')
      .attr('fill', typeColor(d.type1))
      .attr('font-size', '9px').attr('font-weight', '600')
      .attr('pointer-events', 'none')
      .text(d.name);
  });

  // ── LASSO: freehand polygon selection ─────────────────────
  let lassoPoints  = [];
  let lassoActive  = false;
  let lassoWasDrag = false;

  // Hull layer — convex-hull polygons per type (sits UNDER dots in SVG order)
  const hullG = g.append('g').attr('class', 'hull-layer');

  // Transparent overlay catches background mousedown to start the lasso.
  // It lives under the dots; a click on a dot goes to the dot first (stopPropagation).
  const lassoOverlay = g.append('rect')
    .attr('class', 'lasso-overlay')
    .attr('width', iW).attr('height', iH)
    .attr('fill', 'transparent')
    .style('cursor', 'crosshair');

  // ── DOTS (persistent across modes) ─────────────────────────
  const dots = g.selectAll('.dot').data(data).join('circle')
    .attr('class', 'dot')
    .attr('cx', d => xScale(d.offence)).attr('cy', d => yScale(d.defence))
    .attr('r',  d => rScale(d.total))
    .attr('fill', d => typeColor(d.type1)).attr('opacity', 0.65)
    .attr('stroke', '#fff').attr('stroke-width', 0.4)
    .attr('display', d => activeTypes.has(d.type1) ? null : 'none')
    .on('mousedown', function(event) {
      // Stop mousedown from reaching the brush overlay — prevents brush start
      // from wiping selectedName when the user clicks a dot.
      event.stopPropagation();
    })
    .on('click', function(event, d) {
      event.stopPropagation();
      brushedNames = null;
      selectedName = (selectedName === d.name) ? null : d.name;
      clearLasso();
      if (updaters.bar)     updaters.bar();
      if (updaters.scatter) updaters.scatter();
      if (updaters.pcp)     updaters.pcp();
    })
    .on('mouseover', function(event, d) {
      // No visual change on hover — tooltip only. Prevents accidental highlights
      // when moving the mouse across the scatter.
      tip.transition().duration(80).style('opacity', 0.95);
      let html = `<strong>${d.name}</strong><br>` +
        `Type: ${d.type1}${d.type2 ? ' / ' + d.type2 : ''}<br>` +
        `Offence (ATK+SpATK)&nbsp;${d.offence}&ensp;·&ensp;Defence (HP+DEF+SpDEF)&nbsp;${d.defence}`;
      if (scatterMode === 'type') {
        const a = typeAvgsMap.get(d.type1);
        html += `<br><span style="color:${typeColor(d.type1)}">${d.type1} group:</span> ${a.count} Pokémon · avg Off ${a.offence.toFixed(1)} · avg Def ${a.defence.toFixed(1)}`;
      } else if (scatterMode === 'kmeans') {
        const i  = data.indexOf(d);
        const c  = centroids[labels[i]];
        const ci = labels[i];
        html += `<br><span style="color:${CLUSTER_COLORS[ci]}">${c.name}:</span> ${c.count} Pokémon`;
      }
      tip.html(html)
        .style('left', (event.pageX + 14) + 'px').style('top', (event.pageY - 34) + 'px');
    })
    .on('mousemove', event => {
      tip.style('left', (event.pageX + 14) + 'px').style('top', (event.pageY - 34) + 'px');
    })
    .on('mouseout', function() {
      tip.transition().duration(150).style('opacity', 0);
    });

  // ── Lasso path (on top of dots — shows freehand outline while drawing) ──
  const lassoPath = g.append('path')
    .attr('class', 'lasso-path')
    .attr('fill', 'rgba(99,144,240,0.10)')
    .attr('stroke', '#6390F0')
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', '4,2')
    .attr('pointer-events', 'none')
    .attr('d', '');

  function clearLasso() {
    lassoPath.attr('d', '');
    lassoPoints = [];
    lassoActive = false;
  }

  // Wire the lasso overlay now that lassoPath + clearLasso are defined
  lassoOverlay.on('mousedown', function(event) {
    if (event.shiftKey || event.button !== 0) return;   // shift = pan
    if (scatterMode !== 'all') return;                   // only in individual mode
    selectedName = null;
    lassoActive  = true;
    lassoWasDrag = false;
    lassoPoints  = [d3.pointer(event, g.node())];
    event.preventDefault();
    d3.select(window)
      .on('mousemove.lasso', function(ev) {
        if (!lassoActive) return;
        lassoWasDrag = true;
        const [mx, my] = d3.pointer(ev, g.node());
        lassoPoints.push([Math.max(0, Math.min(iW, mx)), Math.max(0, Math.min(iH, my))]);
        lassoPath.attr('d', `M${lassoPoints.map(p => p.join(',')).join('L')}Z`);
      })
      .on('mouseup.lasso', function() {
        if (!lassoActive) return;
        lassoActive = false;
        d3.select(window).on('mousemove.lasso', null).on('mouseup.lasso', null);
        if (lassoWasDrag && lassoPoints.length > 3) {
          // Apply lasso — test which dots fall inside the polygon
          const newSel = new Set();
          dots.each(function(d) {
            if (!activeTypes.has(d.type1)) return;
            if (d3.polygonContains(lassoPoints,
                [+this.getAttribute('cx'), +this.getAttribute('cy')])) {
              newSel.add(d.name);
            }
          });
          brushedNames = newSel.size > 0 ? newSel : null;
          if (brushedNames) {
            dots.attr('opacity', d => !activeTypes.has(d.type1) ? 0 :
                brushedNames.has(d.name) ? 0.95 : 0.06)
              .attr('stroke', d => brushedNames.has(d.name) ? '#222' : '#fff')
              .attr('stroke-width', d => brushedNames.has(d.name) ? 1.5 : 0.4);
            if (updaters.bar) updaters.bar();
            if (updaters.pcp) updaters.pcp();
          } else {
            clearLasso();
            if (updaters.bar)     updaters.bar();
            if (updaters.scatter) updaters.scatter();
            if (updaters.pcp)     updaters.pcp();
          }
        } else {
          // Bare click on background — clear everything
          brushedNames = null;
          clearLasso();
          if (updaters.bar)     updaters.bar();
          if (updaters.scatter) updaters.scatter();
          if (updaters.pcp)     updaters.pcp();
        }
      });
  });

  // ── Type centroid decorations (rings + labels) ────────────
  const typeDecor = g.append('g').attr('class', 'type-decor').style('opacity', scatterMode === 'type' ? 1 : 0);
  typeDecor.selectAll('.type-ring').data(typeAvgsArr).join('circle')
    .attr('class', 'type-ring')
    .attr('cx', d => xScale(d.offence)).attr('cy', d => yScale(d.defence))
    .attr('r', 14)
    .attr('fill', 'none').attr('stroke', d => typeColor(d.type)).attr('stroke-width', 2)
    .attr('opacity', 0.7);
  typeDecor.selectAll('.type-label').data(typeAvgsArr).join('text')
    .attr('class', 'type-label')
    .attr('x', d => xScale(d.offence)).attr('y', d => yScale(d.defence) - 18)
    .attr('text-anchor', 'middle')
    .attr('fill', d => typeColor(d.type))
    .attr('font-size', '10px').attr('font-weight', '700')
    .text(d => `${d.type} (${d.count})`);

  // ── Cluster decorations ───────────────────────────────────
  const kmDecor = g.append('g').attr('class', 'km-decor').style('opacity', scatterMode === 'kmeans' ? 1 : 0);
  kmDecor.selectAll('.cluster-ring').data(centroids).join('circle')
    .attr('class', 'cluster-ring')
    .attr('cx', d => xScale(d.offence)).attr('cy', d => yScale(d.defence))
    .attr('r', d => countScale(d.count))
    .attr('fill', (_, i) => CLUSTER_COLORS[i]).attr('opacity', 0.1)
    .attr('stroke', (_, i) => CLUSTER_COLORS[i]).attr('stroke-width', 2);
  kmDecor.selectAll('.cluster-label').data(centroids).join('text')
    .attr('class', 'cluster-label')
    .attr('x', d => xScale(d.offence))
    .attr('y', d => yScale(d.defence) - countScale(d.count) - 4)
    .attr('text-anchor', 'middle')
    .attr('fill', (_, i) => CLUSTER_COLORS[i])
    .attr('font-size', '11px').attr('font-weight', '700')
    .text(d => `${d.name} (${d.count})`);

  // ── Mode application (the morph) ─────────────────────────
  function applyMode() {
    clearLasso();

    // Hide/show outlier labels — only meaningful in Individual mode
    outlierG.style('display', scatterMode === 'all' ? null : 'none');

    if (scatterMode === 'type') {
      // ── TYPE AVERAGES: convex-hull approach ───────────────────
      // Dots stay at their individual positions (showing the actual spread)
      // and fade to near-invisible. A convex hull per type fades in to
      // reveal the region each type occupies in offence–defence space.
      typeDecor.style('opacity', 1);
      kmDecor.style('opacity', 0);

      const RESET_MS  = 350;   // return dots to individual positions (from kmeans)
      const FADE_OUT  = 200;   // fade dots to near-invisible
      const HULL_BASE = RESET_MS + FADE_OUT + 50;  // hulls start appearing after
      const HULL_STAG = 55;    // stagger per type
      const HULL_DUR  = 300;   // each hull fade-in duration

      // Interrupt any ongoing kmeans transitions, snap dots back to their
      // individual positions, then fade them out
      dots.interrupt()
        .transition().duration(RESET_MS).ease(d3.easeCubicInOut)
          .attr('cx', d => xScale(d.offence))
          .attr('cy', d => yScale(d.defence))
          .attr('r',  d => rScale(d.total))
        .transition().duration(FADE_OUT)
          .attr('opacity', d => activeTypes.has(d.type1) ? 0.12 : 0);

      // Clear any previous hulls then draw one per active type
      hullG.selectAll('.type-hull').remove();
      [...typeAvgsMap.keys()].filter(t => activeTypes.has(t)).forEach((type, ti) => {
        const pts  = data.filter(d => d.type1 === type);
        if (pts.length < 3) return;
        const hull = d3.polygonHull(pts.map(d => [d.offence, d.defence]));
        if (!hull) return;
        hullG.append('path')
          .attr('class', 'type-hull')
          .attr('data-type', type)
          .attr('fill', typeColor(type))
          .attr('stroke', typeColor(type))
          .attr('stroke-width', 1.5)
          .attr('fill-opacity', 0)
          .attr('stroke-opacity', 0)
          .attr('pointer-events', 'none')
          .attr('d', `M${hull.map(([o, e]) => `${xScale(o)},${yScale(e)}`).join('L')}Z`)
          .transition().delay(HULL_BASE + ti * HULL_STAG).duration(HULL_DUR)
            .attr('fill-opacity', 0.13)
            .attr('stroke-opacity', 0.75);
      });

    } else if (scatterMode === 'kmeans') {
      // ── K-MEANS: fade hulls out first, then dim-then-flash ──
      hullG.selectAll('.type-hull').interrupt()
        .transition().duration(200)
          .attr('fill-opacity', 0).attr('stroke-opacity', 0)
          .remove();
      typeDecor.style('opacity', 0);
      kmDecor.style('opacity', 1); // show cluster rings immediately

      const DIM_MS   = 600;
      const GAP_MS   = 840;
      const FLASH_MS = 540;
      const MOVE_MS  = 2100;
      const INTERVAL = 840;

      dots.transition().duration(DIM_MS).attr('opacity', 0);

      [0, 1, 2, 3, 4].forEach((cluster, gi) => {
        const groupDots = dots.filter((d, i) => activeTypes.has(d.type1) && labels[i] === cluster);
        const startAt   = GAP_MS + gi * INTERVAL;

        groupDots
          .transition().delay(startAt).duration(FLASH_MS).ease(d3.easeLinear)
          .attr('opacity', 0.95)
          .transition().duration(MOVE_MS).ease(d3.easeCubicInOut)
          .attr('cx', (d, i) => xScale(dataPos(d, i, 'kmeans').a))
          .attr('cy', (d, i) => yScale(dataPos(d, i, 'kmeans').e))
          .attr('opacity', 0.85);
      });

    } else {
      // ── Return to Individual ──
      // Fade out and remove any hulls
      hullG.selectAll('.type-hull').interrupt()
        .transition().duration(200)
          .attr('fill-opacity', 0).attr('stroke-opacity', 0)
          .remove();
      typeDecor.transition().duration(400).style('opacity', 0);
      kmDecor.transition().duration(400).style('opacity', 0);

      // Animate dots back to their individual positions
      dots.interrupt()
        .transition().duration(MORPH_MS).ease(d3.easeCubicInOut)
          .attr('cx', d => xScale(d.offence))
          .attr('cy', d => yScale(d.defence))
          .attr('r',  d => rScale(d.total))
          .attr('opacity', d => !activeTypes.has(d.type1) ? 0 : defaultOp('all'));
    }
  }
  scatterApplyMode = applyMode;

  // ── updaters.scatter — filter / selection (no morph) ──────
  updaters.scatter = () => {
    dots.transition().duration(FADE_MS)
      .attr('opacity', (d, i) => {
        if (!activeTypes.has(d.type1)) return 0;
        if (brushedNames !== null) return brushedNames.has(d.name) ? 0.95 : 0.06;
        if (selectedName !== null) return d.name === selectedName ? 1 : 0.06;
        return defaultOp(scatterMode);
      })
      .attr('stroke', d => selectedName === d.name ? '#222' : '#fff')
      .attr('stroke-width', d => selectedName === d.name ? 2 : 0.4)
      .attr('display', d => activeTypes.has(d.type1) ? null : 'none');
    // Hide hulls for type-toggled-off types
    hullG.selectAll('.type-hull').each(function() {
      const type = this.getAttribute('data-type');
      d3.select(this).attr('display', activeTypes.has(type) ? null : 'none');
    });
  };

  // ── Axes (kept as refs so zoom can rescale them) ─────────
  const xAxisG = g.append('g').attr('class', 'axis x-axis')
    .attr('transform', `translate(0,${iH})`)
    .call(d3.axisBottom(xScale).ticks(6))
    .call(a => a.select('.domain').attr('stroke', '#ccc'));
  xAxisG.selectAll('text').attr('fill', '#555');
  const yAxisG = g.append('g').attr('class', 'axis y-axis')
    .call(d3.axisLeft(yScale).ticks(6))
    .call(a => a.select('.domain').attr('stroke', '#ccc'));
  yAxisG.selectAll('text').attr('fill', '#555');
  g.append('text').attr('class', 'axis-label')
    .attr('x', iW / 2).attr('y', iH + 38)
    .attr('text-anchor', 'middle').attr('fill', '#666').attr('font-size', '12px')
    .text('Offence (Attack + Sp.Atk)');
  g.append('text').attr('class', 'axis-label')
    .attr('transform', 'rotate(-90)').attr('x', -iH / 2).attr('y', -40)
    .attr('text-anchor', 'middle').attr('fill', '#666').attr('font-size', '12px')
    .text('Defence (HP + Defense + Sp.Def)');

  // ── PAN/ZOOM (wheel = zoom, shift+drag = pan; brush handles regular drag) ──
  // Clip path so zoomed/panned dots don't render outside the plot area
  svg.append('defs').append('clipPath').attr('id', 'scatter-clip')
    .append('rect').attr('width', iW).attr('height', iH);
  // Move dots + decorations into a clipped group so they don't bleed into legend
  // (we can't easily reparent here without restructuring; instead just rely on opacity 0 outside)

  function applyZoomTransform(t) {
    currentTransform = t;
    xScale = t.rescaleX(baseXScale);
    yScale = t.rescaleY(baseYScale);

    // In type mode dots stay at their individual positions (hulls show grouping)
    const zoomMode = scatterMode === 'type' ? 'all' : scatterMode;
    dots.attr('cx', (d, i) => xScale(dataPos(d, i, zoomMode).a))
        .attr('cy', (d, i) => yScale(dataPos(d, i, zoomMode).e));

    // Move type decorations
    typeDecor.selectAll('.type-ring')
      .attr('cx', d => xScale(d.offence)).attr('cy', d => yScale(d.defence));
    typeDecor.selectAll('.type-label')
      .attr('x', d => xScale(d.offence)).attr('y', d => yScale(d.defence) - 18);

    // Move cluster decorations
    kmDecor.selectAll('.cluster-ring')
      .attr('cx', d => xScale(d.offence)).attr('cy', d => yScale(d.defence));
    kmDecor.selectAll('.cluster-label')
      .attr('x', d => xScale(d.offence))
      .attr('y', d => yScale(d.defence) - countScale(d.count) - 4);

    // Reference diagonal (defence = offence + meanHP)
    atkDefLine
      .attr('x1', xScale(0)).attr('y1', yScale(meanHP))
      .attr('x2', xScale(diagEndX)).attr('y2', yScale(diagEndX + meanHP));
    atkDefLabel
      .attr('x', xScale(diagEndX) - 4).attr('y', yScale(diagEndX + meanHP) - 6);

    // Reposition hull polygons (type-avg mode)
    hullG.selectAll('.type-hull').each(function() {
      const type = this.getAttribute('data-type');
      const pts  = data.filter(d => d.type1 === type);
      if (pts.length < 3) return;
      const hull = d3.polygonHull(pts.map(d => [d.offence, d.defence]));
      if (!hull) return;
      d3.select(this).attr('d',
        `M${hull.map(([o, e]) => `${xScale(o)},${yScale(e)}`).join('L')}Z`);
    });

    // Axes
    xAxisG.call(d3.axisBottom(xScale).ticks(6))
      .call(a => a.select('.domain').attr('stroke', '#ccc'))
      .selectAll('text').attr('fill', '#555');
    yAxisG.call(d3.axisLeft(yScale).ticks(6))
      .call(a => a.select('.domain').attr('stroke', '#ccc'))
      .selectAll('text').attr('fill', '#555');
  }

  const zoomBehavior = d3.zoom()
    .scaleExtent([1, 8])
    .translateExtent([[0, 0], [iW, iH]])
    .extent([[0, 0], [iW, iH]])
    // Only wheel events or shift+drag start a zoom; regular mousedown is for brush
    .filter(event => {
      if (event.type === 'wheel') return true;
      if (event.type === 'mousedown' && event.shiftKey) return true;
      return false;
    })
    .on('zoom', event => applyZoomTransform(event.transform));

  svg.call(zoomBehavior);
  // Double-click resets zoom
  svg.on('dblclick.zoom', () => {
    svg.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity);
  });

  // ── Type legend (clickable) ──────────────────────────────
  const legG = g.append('g').attr('transform', `translate(${iW + 14}, 0)`);
  legG.append('text').attr('y', -4)
    .attr('fill', '#555').attr('font-size', '11px').attr('font-weight', '600')
    .text('Type (click to filter)');
  const legColW = 68;
  ALL_TYPES.forEach((type, i) => {
    const col = Math.floor(i / 9), row = i % 9;
    const itemG = legG.append('g')
      .attr('class', `legend-item${activeTypes.has(type) ? '' : ' inactive'}`)
      .attr('transform', `translate(${col * legColW}, ${row * 14 + 8})`);
    itemG.append('circle').attr('r', 5).attr('cx', 5)
      .attr('fill', typeColor(type)).attr('opacity', 0.9);
    itemG.append('text').attr('x', 13).attr('dy', '0.35em')
      .attr('fill', '#333').attr('font-size', '10px').text(type);
    itemG.on('click', () => toggleType(type, itemG));
  });

  // Apply initial mode (no animation since dots start at 'all' positions)
  if (scatterMode !== 'all') applyMode();
}

// ─────────────────────────────────────────────────────────────
// View 3 — Parallel Coordinates (Advanced Focus)
//
// Persistent polylines — one per Pokémon — that animate between modes.
// Same morph pattern as the scatter: switching to Type Averages or
// K-Means causes every individual line to slide toward its group's
// centroid path, and many lines pile up to form a thicker visible
// "ribbon" per group.
// ─────────────────────────────────────────────────────────────
function drawPCP(data) {
  const { w: W, h: H } = dims('pcp-chart');
  if (!W || !H) return;

  const tip = d3.select('.tooltip');

  const m  = { top: 28, right: 152, bottom: 34, left: 42 };
  const iW = W - m.left - m.right;
  const iH = H - m.top  - m.bottom;

  const svg = d3.select('#pcp-chart').append('svg').attr('width', W).attr('height', H);
  const g   = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  const yScales = Object.fromEntries(
    STAT_KEYS.map(key => [key, d3.scaleLinear()
      .domain([0, d3.max(data, d => d[key])])
      .range([iH, 0])
      .nice()])
  );
  const xScale = d3.scalePoint().domain(STAT_KEYS).range([0, iW]);

  function pcpPath(profile) {
    return d3.line()(STAT_KEYS.map(k => [xScale(k), yScales[k](profile[k] || 0)]));
  }

  // Group targets pre-computed
  const typeAvgsMap = new Map();
  d3.rollup(data, v => ({
    type: v[0].type1, count: v.length,
    ...Object.fromEntries(STAT_KEYS.map(k => [k, d3.mean(v, d => d[k])]))
  }), d => d.type1).forEach((v, k) => typeAvgsMap.set(k, v));

  const { centroids, labels } = kMeans(data, 5);

  function targetProfile(d, i, mode) {
    if (mode === 'all')    return d;
    if (mode === 'type')   return typeAvgsMap.get(d.type1);
    /* kmeans */           return centroids[labels[i]];
  }

  // Color for the line in the current mode
  function lineColor(d, i, mode) {
    if (mode === 'kmeans') return CLUSTER_COLORS[labels[i]];
    return typeColor(d.type1);
  }

  const typeAvgsArr = [...typeAvgsMap.values()];

  // ── PERSISTENT INDIVIDUAL LINES (one per Pokémon, morph between modes) ──
  // In 'all' mode: invisible by default. Only the hovered / selected line shows.
  // This removes clutter — the PCP becomes a "probe" for individual Pokémon.
  const lines = g.selectAll('.pcp-line').data(data).join('path')
    .attr('class', 'pcp-line')
    .attr('d', d => pcpPath(d))
    .attr('fill', 'none')
    .attr('stroke', d => typeColor(d.type1))
    .attr('stroke-width', 1.5)
    .attr('opacity', 0)              // invisible until hovered / selected
    .attr('pointer-events', 'none')  // all events go to hitLines
    .attr('display', d => activeTypes.has(d.type1) ? null : 'none');

  // Hint text shown when nothing is selected in Individual mode
  const pcpHintText = g.append('text')
    .attr('x', iW / 2).attr('y', iH / 2)
    .attr('text-anchor', 'middle').attr('fill', '#bbb')
    .attr('font-size', '12px').attr('pointer-events', 'none')
    .style('display', pcpMode === 'all' && !selectedName ? null : 'none')
    .text('Hover a line or select a Pokémon in the scatter');

  // ── HIT AREAS: invisible wide paths for reliable hover/click ──
  // 1026 visible lines are 1px wide — impossible to click precisely.
  // These transparent 10px paths sit on top and give a large hit area.
  const hitLines = g.selectAll('.pcp-hit').data(data).join('path')
    .attr('class', 'pcp-hit')
    .attr('d', d => pcpPath(d))
    .attr('fill', 'none')
    .attr('stroke', 'transparent')
    .attr('stroke-width', 10)
    .attr('pointer-events', pcpMode === 'all' ? 'auto' : 'none')
    .style('cursor', 'pointer')
    .on('click', function(event, d) {
      if (pcpMode !== 'all') return;
      event.stopPropagation();
      brushedNames = null;
      selectedName = (selectedName === d.name) ? null : d.name;
      if (updaters.bar)     updaters.bar();
      if (updaters.scatter) updaters.scatter();
      if (updaters.pcp)     updaters.pcp();
    })
    .on('mouseover', function(event, d) {
      if (pcpMode !== 'all') return;
      // When something is selected, only allow the selected line's hit area to respond
      if (selectedName !== null && selectedName !== d.name) return;
      pcpHintText.style('display', 'none');
      lines.filter(l => l.name === d.name)
        .raise()
        .attr('stroke-width', 2).attr('opacity', 0.9);
      tip.transition().duration(80).style('opacity', 0.95);
      tip.html(
        `<strong>${d.name}</strong>&ensp;<span style="color:${typeColor(d.type1)}">${d.type1}${d.type2?' / '+d.type2:''}</span><br>` +
        STAT_KEYS.map((k, j) => `${STAT_LABELS[j]}: <b>${d[k]}</b>`).join('&ensp;·&ensp;')
      ).style('left',(event.pageX+14)+'px').style('top',(event.pageY-36)+'px');
    })
    .on('mousemove', event => {
      tip.style('left',(event.pageX+14)+'px').style('top',(event.pageY-36)+'px');
    })
    .on('mouseout', function(event, d) {
      if (pcpMode !== 'all') return;
      if (selectedName !== null && selectedName !== d.name) return;
      const isSel = selectedName === d.name;
      lines.filter(l => l.name === d.name)
        .attr('stroke-width', isSel ? 2 : 1.5)
        .attr('opacity', isSel ? 1 : (brushedNames?.has(d.name) ? 0.7 : 0));
      if (!selectedName) pcpHintText.style('display', null);
      tip.transition().duration(150).style('opacity', 0);
    });

  // ── CLEAN GROUP-CENTROID LINES (fade in/out by mode) ──────
  // 18 type-average lines — clean, bold, only visible in 'type' mode
  const typeLines = g.selectAll('.type-line').data(typeAvgsArr).join('path')
    .attr('class', 'type-line')
    .attr('d', d => pcpPath(d))
    .attr('fill', 'none')
    .attr('stroke', d => typeColor(d.type))
    .attr('stroke-width', 2.5)
    .attr('opacity', pcpMode === 'type' ? 0.85 : 0)
    .attr('pointer-events', pcpMode === 'type' ? 'auto' : 'none')
    .attr('display', d => activeTypes.has(d.type) ? null : 'none')
    .on('mouseover', function(event, d) {
      if (pcpMode !== 'type') return;
      d3.select(this).raise().attr('stroke-width', 4).attr('opacity', 1);
      tip.transition().duration(80).style('opacity', 0.95);
      tip.html(
        `<strong style="color:${typeColor(d.type)}">${d.type} (avg)</strong>&ensp;${d.count} Pokémon<br>` +
        STAT_KEYS.map((k, j) => `${STAT_LABELS[j]}: <b>${d[k].toFixed(1)}</b>`).join('&ensp;·&ensp;')
      ).style('left', (event.pageX + 14) + 'px').style('top', (event.pageY - 36) + 'px');
    })
    .on('mousemove', event => { tip.style('left',(event.pageX+14)+'px').style('top',(event.pageY-36)+'px'); })
    .on('mouseout', function() {
      if (pcpMode !== 'type') return;
      d3.select(this).attr('stroke-width', 2.5).attr('opacity', 0.85);
      tip.transition().duration(150).style('opacity', 0);
    });

  // 5 cluster centroid lines — clean, bold, only visible in 'kmeans' mode
  const clusterLines = g.selectAll('.cluster-line').data(centroids).join('path')
    .attr('class', 'cluster-line')
    .attr('d', d => pcpPath(d))
    .attr('fill', 'none')
    .attr('stroke', (_, i) => CLUSTER_COLORS[i])
    .attr('stroke-width', 3)
    .attr('opacity', pcpMode === 'kmeans' ? 0.95 : 0)
    .attr('pointer-events', pcpMode === 'kmeans' ? 'auto' : 'none')
    .on('mouseover', function(event, d) {
      if (pcpMode !== 'kmeans') return;
      const i = centroids.indexOf(d);
      d3.select(this).raise().attr('stroke-width', 5).attr('opacity', 1);
      tip.transition().duration(80).style('opacity', 0.95);
      tip.html(
        `<strong style="color:${CLUSTER_COLORS[i]}">${d.name}</strong>&ensp;(${d.count} Pokémon)<br>` +
        `Top types: ${d.topTypes.map(({t,n}) => `${t}(${n})`).join(', ')}<br>` +
        STAT_KEYS.map((k, j) => `${STAT_LABELS[j]}: <b>${d[k].toFixed(1)}</b>`).join('&ensp;·&ensp;')
      ).style('left',(event.pageX+14)+'px').style('top',(event.pageY-36)+'px');
    })
    .on('mousemove', event => { tip.style('left',(event.pageX+14)+'px').style('top',(event.pageY-36)+'px'); })
    .on('mouseout', function() {
      if (pcpMode !== 'kmeans') return;
      d3.select(this).attr('stroke-width', 3).attr('opacity', 0.95);
      tip.transition().duration(150).style('opacity', 0);
    });

  // ── Apply mode: STAGED transition
  //   Stage 1 (0 → MORPH_MS): individual lines morph to/from group centroids
  //                            so the user SEES which Pokémon go where.
  //   Stage 2 (during morph): individual lines fade to near-invisible while
  //                            clean group lines fade in.  End state = clean HW2-style chart.
  function applyMode() {
    const typeKeys = [...typeAvgsMap.keys()];
    const STAGGER  = 30;
    const groupDelay = (d, i) => {
      if (pcpMode === 'type')   return typeKeys.indexOf(d.type1) * STAGGER;
      if (pcpMode === 'kmeans') return labels[i] * STAGGER;
      return typeKeys.indexOf(d.type1) * (STAGGER / 2); // dispersing to 'all'
    };

    // Stage 1: morph individual lines toward group centroids (staggered by group)
    lines.transition().duration(MORPH_MS).ease(d3.easeCubicInOut)
      .delay(groupDelay)
      .attr('d', (d, i) => pcpPath(targetProfile(d, i, pcpMode)))
      .attr('stroke', (d, i) => lineColor(d, i, pcpMode))
      .attr('opacity', d => {
        if (!activeTypes.has(d.type1)) return 0;
        if (selectedName === d.name) return 1;
        return pcpMode === 'all' ? 0.08 : 0.04;
      });

    // hitLines: update position immediately (invisible anyway), toggle pointer-events
    hitLines.attr('d', (d, i) => pcpPath(targetProfile(d, i, pcpMode)))
      .attr('pointer-events', pcpMode === 'all' ? 'auto' : 'none');

    // Hint text: only show in Individual mode when nothing is selected
    pcpHintText.style('display', pcpMode === 'all' && !selectedName ? null : 'none');

    // Stage 2: clean group lines fade in/out
    typeLines.transition().duration(MORPH_MS)
      .attr('opacity', pcpMode === 'type' ? 0.85 : 0);
    typeLines.attr('pointer-events', pcpMode === 'type' ? 'auto' : 'none');

    clusterLines.transition().duration(MORPH_MS)
      .attr('opacity', pcpMode === 'kmeans' ? 0.95 : 0);
    clusterLines.attr('pointer-events', pcpMode === 'kmeans' ? 'auto' : 'none');

    clusterLegendG.transition().duration(300).style('opacity', pcpMode === 'kmeans' ? 1 : 0);
  }
  pcpApplyMode = applyMode;

  // ── updaters.pcp — filter / brush / selection (no morph) ──
  updaters.pcp = () => {
    const brushedTypes = brushedNames
      ? new Set([...brushedNames].map(n => nameToType1.get(n))) : null;
    const selType = selectedName ? nameToType1.get(selectedName) : null;

    // Individual lines: only show selected / brushed — everything else is 0
    lines.transition().duration(FADE_MS)
      .attr('opacity', d => {
        if (!activeTypes.has(d.type1)) return 0;
        if (pcpMode !== 'all') return 0.04;         // very faint during morph
        if (brushedNames !== null) return brushedNames.has(d.name) ? 0.75 : 0;
        if (selectedName !== null) return d.name === selectedName ? 1 : 0;
        return 0;   // default in Individual mode: blank until hovered
      })
      .attr('stroke-width', d => selectedName === d.name ? 2 : 1.5)
      .attr('display', d => activeTypes.has(d.type1) ? null : 'none');

    if (selectedName) lines.filter(d => d.name === selectedName).raise();

    // When a Pokémon is selected: disable ALL other hit areas so nothing can
    // be accidentally hovered or clicked — only the selected line's hit area
    // stays active (for click-to-deselect).
    hitLines.attr('pointer-events', d => {
      if (pcpMode !== 'all') return 'none';
      if (selectedName !== null) return d.name === selectedName ? 'auto' : 'none';
      if (brushedNames !== null) return brushedNames.has(d.name) ? 'auto' : 'none';
      return 'auto';
    });

    // Show/hide hint text
    pcpHintText.style('display', pcpMode === 'all' && !selectedName && !brushedNames ? null : 'none');

    // Clean type-average lines
    typeLines.transition().duration(FADE_MS)
      .attr('display', d => activeTypes.has(d.type) ? null : 'none')
      .attr('opacity', d => {
        if (pcpMode !== 'type') return 0;
        if (!activeTypes.has(d.type)) return 0;
        if (selType) return d.type === selType ? 1 : 0.15;
        if (brushedTypes) return brushedTypes.has(d.type) ? 1 : 0.15;
        return 0.85;
      })
      .attr('stroke-width', d => selType === d.type ? 4 : 2.5);
  };

  // ── Vertical axes (labels only on leftmost) ──────────────
  STAT_KEYS.forEach((key, i) => {
    const axisG = g.append('g').attr('transform', `translate(${xScale(key)},0)`);
    const axisFn = i === 0
      ? d3.axisLeft(yScales[key]).ticks(4)
      : d3.axisLeft(yScales[key]).ticks(4).tickFormat('');
    axisG.call(axisFn)
      .call(a => a.select('.domain').attr('stroke', '#aaa').attr('stroke-width', 1.5))
      .selectAll('text').attr('fill', '#666').attr('font-size', '8px');
    g.append('text')
      .attr('x', xScale(key)).attr('y', iH + 22)
      .attr('text-anchor', 'middle')
      .attr('fill', '#333').attr('font-size', '11px').attr('font-weight', '600')
      .text(STAT_LABELS[i]);
  });

  // ── Cluster legend (visible only in kmeans mode) ─────────
  const clusterLegendG = g.append('g')
    .attr('class', 'cluster-legend')
    .attr('transform', `translate(${iW + 16}, 0)`)
    .style('opacity', pcpMode === 'kmeans' ? 1 : 0);
  clusterLegendG.append('text').attr('y', -4)
    .attr('fill', '#555').attr('font-size', '11px').attr('font-weight', '600')
    .text('Clusters');
  centroids.forEach((c, i) => {
    const rg = clusterLegendG.append('g').attr('transform', `translate(0,${i * 32 + 8})`);
    rg.append('rect').attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', CLUSTER_COLORS[i]);
    rg.append('text').attr('x', 14).attr('y', 9).attr('fill', '#222').attr('font-size', '10px').text(c.name);
    rg.append('text').attr('x', 14).attr('y', 20).attr('fill', '#888').attr('font-size', '9px')
      .text(`${c.count} Pokémon`);
  });

  // ── Type legend ──────────────────────────────────────────
  const legG = g.append('g').attr('transform', `translate(${iW + 16}, ${5 * 32 + 22})`);
  legG.append('text').attr('y', -4)
    .attr('fill', '#555').attr('font-size', '11px').attr('font-weight', '600')
    .text('Type (click to filter)');
  ALL_TYPES.forEach((type, i) => {
    const col = Math.floor(i / 9), row = i % 9;
    const itemG = legG.append('g')
      .attr('class', `legend-item${activeTypes.has(type) ? '' : ' inactive'}`)
      .attr('transform', `translate(${col * 68}, ${row * 14 + 8})`);
    itemG.append('circle').attr('r', 5).attr('cx', 5).attr('fill', typeColor(type)).attr('opacity', 0.9);
    itemG.append('text').attr('x', 13).attr('dy', '0.35em').attr('fill', '#333').attr('font-size', '10px')
      .text(type);
    itemG.on('click', () => toggleType(type, itemG));
  });

  // Apply initial mode (no animation — lines start at 'all' state)
  if (pcpMode !== 'all') applyMode();
}
