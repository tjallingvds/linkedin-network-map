/**
 * Three.js 3D graph visualization and all UI rendering.
 * This is the main application module.
 */

// ─── Data & State ───
let DATA = [];
let filtered = [];
let activeCategory = 'all';
let activeIndustry = '';
let activeRole = '';
let activeView = 'chat';
let clusterMode = 'category';
let selectedNode = null;
let hoveredNode = null;

// Three.js
let scene, camera, renderer, controls;
let raycaster, mouse;
let nodeMeshes = [];
let edgeMeshes = [];
let positions = [];
let velocities = [];
let targetPositions = [];
let animFrame;
let clusterLabels = [];

const INDUSTRY_COLORS = {
  'AI & Machine Learning': '#6366F1',
  'Software & Developer Tools': '#3B82F6',
  'Big Tech': '#0EA5E9',
  'Fintech & Financial Services': '#14B8A6',
  'Venture Capital & Investment': '#8B5CF6',
  'Startups & Accelerators': '#F97316',
  'Healthcare & Biotech': '#EC4899',
  'Education & Research': '#10B981',
  'Climate & Energy': '#22C55E',
  'Robotics, Space & Hardware': '#EF4444',
  'Consulting & Professional Services': '#64748B',
  'Consumer & Retail': '#F59E0B',
  'Media & Creative': '#A855F7',
  'Government & Non-profit': '#06B6D4',
  'Legal & Real Estate': '#78716C',
  'Travel & Hospitality': '#FB923C',
  'Talent & HR': '#84CC16',
  'Other': '#A0A090',
};

// ─── Three.js Init ───
function initThree() {
  const wrap = document.getElementById('canvasWrap');
  const canvas = document.getElementById('graphCanvas');
  if (!wrap || !canvas) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#FFFFFF');

  camera = new THREE.PerspectiveCamera(50, wrap.clientWidth / wrap.clientHeight, 1, 10000);
  camera.position.set(0, 40, 700);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.5;
  controls.minDistance = 30;
  controls.maxDistance = 1200;

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  scene.add(ambient);
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.6);
  dir1.position.set(200, 300, 400);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0xfaf0e6, 0.3);
  dir2.position.set(-200, -100, -200);
  scene.add(dir2);

  raycaster = new THREE.Raycaster();
  raycaster.params.Points = { threshold: 5 };
  mouse = new THREE.Vector2();

  // Events
  canvas.addEventListener('mousemove', onMouseMove, false);
  canvas.addEventListener('click', onCanvasClick, false);
  window.addEventListener('resize', onResize, false);

  // Zoom limits
  canvas.addEventListener('wheel', (e) => {
    const dist = camera.position.distanceTo(controls.target);
    if ((e.deltaY > 0 && dist >= controls.maxDistance) || (e.deltaY < 0 && dist <= controls.minDistance)) {
      e.preventDefault();
    }
    if (dist > controls.maxDistance) {
      const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
      camera.position.copy(controls.target).add(dir.multiplyScalar(controls.maxDistance));
    }
    controls.update();
  }, { passive: false });
}

function onResize() {
  if (!camera || !renderer) return;
  const wrap = document.getElementById('canvasWrap');
  if (!wrap.clientWidth || !wrap.clientHeight) return;
  camera.aspect = wrap.clientWidth / wrap.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
}

function onMouseMove(e) {
  const wrap = document.getElementById('canvasWrap');
  const rect = wrap.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(nodeMeshes);
  const CATEGORIES = Categorizer.CATEGORIES;

  const tooltip = document.getElementById('tooltip');
  if (intersects.length > 0) {
    const mesh = intersects[0].object;
    const p = mesh.userData;
    const cat = CATEGORIES[p._cat];
    tooltip.innerHTML = `
      <div class="tooltip-name">${p.f} ${p.l}</div>
      <div class="tooltip-role">${p.p || 'No title'}</div>
      <div class="tooltip-company">${p.c || 'No company'}</div>
      ${p.e ? `<div class="tooltip-email">${p.e}</div>` : ''}
      <div class="tooltip-cat" style="background:${cat.color}18;color:${cat.color}">${cat.label}</div>
      <div class="tooltip-hint">Click for details</div>
    `;
    tooltip.style.left = (e.clientX + 16) + 'px';
    tooltip.style.top = (e.clientY - 10) + 'px';
    tooltip.classList.add('visible');
    document.body.style.cursor = 'pointer';
    hoveredNode = mesh;
  } else {
    tooltip.classList.remove('visible');
    document.body.style.cursor = 'default';
    hoveredNode = null;
  }
}

function onCanvasClick(e) {
  if (!hoveredNode) return;
  const p = hoveredNode.userData;
  const clusterKey = p._clusterKey || p._cat;
  zoomToCluster(clusterKey, p);
}

// ─── Clustering ───
function getClusterCenters(data, mode) {
  const catCenters = {};
  const companyCenters = {};
  const radius = 200;

  const activeCats = [...new Set(data.map(p => p._cat))];
  activeCats.forEach((key, i) => {
    const phi = Math.acos(1 - 2 * (i + 0.5) / activeCats.length);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    catCenters[key] = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta) * radius,
      Math.sin(phi) * Math.sin(theta) * radius,
      Math.cos(phi) * radius * 0.8
    );
  });

  const companyCounts = {};
  data.forEach(p => { if (p.c) companyCounts[p.c] = (companyCounts[p.c]||0) + 1; });
  const topCompanies = Object.entries(companyCounts).filter(([,n]) => n >= 2).sort((a,b) => b[1]-a[1]).map(e => e[0]);
  const allCompanySlots = topCompanies.length + 1;
  topCompanies.forEach((comp, i) => {
    const phi = Math.acos(1 - 2 * (i + 0.5) / allCompanySlots);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    companyCenters[comp] = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta) * radius,
      Math.sin(phi) * Math.sin(theta) * radius,
      Math.cos(phi) * radius * 0.8
    );
  });
  const otherIdx = topCompanies.length;
  const otherPhi = Math.acos(1 - 2 * (otherIdx + 0.5) / allCompanySlots);
  const otherTheta = Math.PI * (1 + Math.sqrt(5)) * otherIdx;
  companyCenters['_other_companies'] = new THREE.Vector3(
    Math.sin(otherPhi) * Math.cos(otherTheta) * radius,
    Math.sin(otherPhi) * Math.sin(otherTheta) * radius,
    Math.cos(otherPhi) * radius * 0.8
  );

  const industryCenters = {};
  const activeIndustries = [...new Set(data.map(p => p._industry))];
  activeIndustries.forEach((ind, i) => {
    const phi = Math.acos(1 - 2 * (i + 0.5) / activeIndustries.length);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    industryCenters[ind] = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta) * radius,
      Math.sin(phi) * Math.sin(theta) * radius,
      Math.cos(phi) * radius * 0.8
    );
  });

  return { catCenters, companyCenters, industryCenters };
}

function buildGraph() {
  if (!scene) return;
  const CATEGORIES = Categorizer.CATEGORIES;
  nodeMeshes.forEach(m => scene.remove(m));
  edgeMeshes.forEach(m => scene.remove(m));
  clusterLabels.forEach(m => scene.remove(m));
  nodeMeshes = []; edgeMeshes = []; clusterLabels = [];
  positions = []; velocities = []; targetPositions = [];

  const data = DATA;
  if (!data.length) return;

  const { catCenters, companyCenters, industryCenters } = getClusterCenters(data, clusterMode);

  const clusterKey = (p) => {
    if (clusterMode === 'category') return p._cat;
    if (clusterMode === 'company') return companyCenters[p.c] ? p.c : '_other_companies';
    if (clusterMode === 'industry') return p._industry;
    return 'all';
  };

  const clusterSizes = {};
  data.forEach(p => { const k = clusterKey(p); clusterSizes[k] = (clusterSizes[k]||0) + 1; });
  const clusterCounter = {};

  data.forEach((p, i) => {
    const cat = CATEGORIES[p._cat];
    const score = DataLoader.discoveryScore(p);
    const baseSize = 1.4 + (score / 60) * 3.0;

    const geometry = new THREE.SphereGeometry(baseSize, 12, 12);
    const material = new THREE.MeshPhongMaterial({
      color: new THREE.Color(cat.color),
      transparent: true, opacity: 0.88, shininess: 80,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = p;
    mesh.userData._clusterKey = clusterKey(p);

    let center;
    const ck = clusterKey(p);
    if (clusterMode === 'category') center = catCenters[p._cat] || new THREE.Vector3();
    else if (clusterMode === 'company') center = companyCenters[p.c] || companyCenters['_other_companies'] || new THREE.Vector3();
    else if (clusterMode === 'industry') center = industryCenters[p._industry] || new THREE.Vector3();
    else center = new THREE.Vector3();

    if (!clusterCounter[ck]) clusterCounter[ck] = 0;
    const idx = clusterCounter[ck]++;
    const total = clusterSizes[ck];
    const packRadius = Math.pow(total, 0.48) * 18;

    const phi = Math.acos(1 - 2 * (idx + 0.5) / total);
    const theta = Math.PI * (1 + Math.sqrt(5)) * idx;
    const r = packRadius * Math.cbrt((idx + 1) / total);

    let px, py, pz;
    if (clusterMode === 'none') {
      px = (Math.random() - 0.5) * 120;
      py = (Math.random() - 0.5) * 120;
      pz = (Math.random() - 0.5) * 120;
    } else {
      px = center.x + Math.sin(phi) * Math.cos(theta) * r;
      py = center.y + Math.sin(phi) * Math.sin(theta) * r;
      pz = center.z + Math.cos(phi) * r;
    }

    mesh.position.set(px, py, pz);
    positions.push(new THREE.Vector3(px, py, pz));
    velocities.push(new THREE.Vector3());
    targetPositions.push(new THREE.Vector3(px, py, pz));
    scene.add(mesh);
    nodeMeshes.push(mesh);
  });

  simulateForces(clusterMode === 'none' ? 120 : 110);

  // Add cluster labels
  if (clusterMode !== 'none') {
    const keysToLabel = clusterMode === 'category'
      ? Object.keys(catCenters)
      : clusterMode === 'industry'
      ? Object.keys(industryCenters)
      : Object.keys(companyCenters);

    for (const key of keysToLabel) {
      const count = data.filter(p => clusterKey(p) === key).length;
      if (count === 0) continue;

      let cx = 0, cy = 0, cz = 0, cn = 0;
      nodeMeshes.forEach((m, i) => {
        if (m.userData._clusterKey === key) {
          cx += targetPositions[i].x; cy += targetPositions[i].y; cz += targetPositions[i].z; cn++;
        }
      });
      if (cn === 0) continue;
      cx /= cn; cy /= cn; cz /= cn;

      let maxY = -Infinity;
      nodeMeshes.forEach((m, i) => {
        if (m.userData._clusterKey === key && targetPositions[i].y > maxY) maxY = targetPositions[i].y;
      });

      const label = clusterMode === 'category' ? CATEGORIES[key].label : (key === '_other_companies' ? 'Other' : key);
      const color = clusterMode === 'category' && CATEGORIES[key] ? CATEGORIES[key].color
        : clusterMode === 'industry' && INDUSTRY_COLORS[key] ? INDUSTRY_COLORS[key]
        : '#191918';
      const sprite = makeTextSprite(`${label} (${count})`, color);
      sprite.position.set(cx, maxY + 25, cz);
      scene.add(sprite);
      clusterLabels.push(sprite);
    }
  }

  // Ungrouped badge
  const badgeEl = document.getElementById('ungroupedBadge');
  if (badgeEl) badgeEl.remove();
  if (clusterMode === 'company') {
    const { companyCenters: cc } = getClusterCenters(data, 'company');
    const ungrouped = data.filter(p => !cc[p.c]).length;
    if (ungrouped > 0) {
      const badge = document.createElement('div');
      badge.id = 'ungroupedBadge';
      badge.className = 'ungrouped-badge';
      badge.innerHTML = `<strong>${ungrouped}</strong> people not in top companies`;
      document.getElementById('canvasWrap').appendChild(badge);
    }
  }
}

function makeTextSprite(text, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 1024; canvas.height = 160;
  ctx.font = '800 56px Inter, sans-serif';
  const metrics = ctx.measureText(text);
  const tw = metrics.width;
  const px = 512, py = 90, padX = 36, padY = 24;
  ctx.shadowColor = 'rgba(0,0,0,0.12)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
  ctx.fillStyle = '#FFFFFFEE';
  ctx.beginPath();
  ctx.roundRect(px - tw/2 - padX, py - 46 - padY/2, tw + padX*2, 64 + padY, 32);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = color + '66'; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(text, px, py);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 1, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(60, 9.375, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function simulateForces(iterations) {
  const n = positions.length;
  if (n === 0) return;
  const { catCenters, companyCenters, industryCenters } = getClusterCenters(DATA, clusterMode);
  const clusterOf = nodeMeshes.map(m => m.userData._clusterKey || 'all');

  for (let iter = 0; iter < iterations; iter++) {
    const t = iter / iterations;
    const alpha = 0.4 * (1 - t);
    for (let i = 0; i < n; i++) {
      const sampleSize = Math.min(n - 1, 30);
      for (let s = 0; s < sampleSize; s++) {
        const j = Math.floor(Math.random() * n);
        if (i === j) continue;
        const dx = positions[i].x - positions[j].x;
        const dy = positions[i].y - positions[j].y;
        const dz = positions[i].z - positions[j].z;
        const distSq = dx*dx + dy*dy + dz*dz + 0.01;
        const dist = Math.sqrt(distSq);
        const sameCluster = clusterOf[i] === clusterOf[j];
        if (sameCluster) {
          if (dist < 12) {
            const f = (12 - dist) * 0.5 * alpha;
            velocities[i].x += (dx / dist) * f;
            velocities[i].y += (dy / dist) * f;
            velocities[i].z += (dz / dist) * f;
          }
        } else {
          const repulsion = (400 / distSq) * alpha * (n / sampleSize);
          velocities[i].x += (dx / dist) * repulsion;
          velocities[i].y += (dy / dist) * repulsion;
          velocities[i].z += (dz / dist) * repulsion;
        }
      }
      if (clusterMode !== 'none') {
        const p = nodeMeshes[i].userData;
        let center;
        if (clusterMode === 'category') center = catCenters[p._cat];
        else if (clusterMode === 'company') center = companyCenters[p.c] || companyCenters['_other_companies'];
        else if (clusterMode === 'industry') center = industryCenters[p._industry];
        if (center) {
          const strength = 0.10 * alpha;
          velocities[i].x += (center.x - positions[i].x) * strength;
          velocities[i].y += (center.y - positions[i].y) * strength;
          velocities[i].z += (center.z - positions[i].z) * strength;
        }
      } else {
        const cg = 0.003 * alpha;
        velocities[i].x -= positions[i].x * cg;
        velocities[i].y -= positions[i].y * cg;
        velocities[i].z -= positions[i].z * cg;
      }
      velocities[i].multiplyScalar(0.5);
      positions[i].add(velocities[i]);
    }
  }
  for (let i = 0; i < n; i++) targetPositions[i].copy(positions[i]);
}

function animate() {
  animFrame = requestAnimationFrame(animate);
  // Skip rendering when graph isn't visible — saves GPU and prevents flicker
  if (activeView !== 'graph') return;
  if (!renderer || !scene || !camera) return;
  controls.update();
  nodeMeshes.forEach((mesh, i) => {
    mesh.position.lerp(targetPositions[i], 0.1);
    const isHovered = hoveredNode === mesh;
    const targetScale = isHovered ? 1.6 : 1;
    const s = mesh.scale.x + (targetScale - mesh.scale.x) * 0.15;
    mesh.scale.set(s, s, s);
    mesh.material.opacity = isHovered ? 1 : 0.85;
  });
  clusterLabels.forEach(sprite => sprite.lookAt(camera.position));
  renderer.render(scene, camera);
}

// ─── UI Rendering ───
function populateFilters() {
  const industries = new Set();
  DATA.forEach(p => industries.add(p._industry));
  const indSelect = document.getElementById('industryFilter');
  indSelect.innerHTML = '<option value="">All industries</option>';
  [...industries].sort().forEach(ind => {
    indSelect.innerHTML += `<option value="${ind}">${ind}</option>`;
  });

  const roles = new Set();
  const roleKeywords = ['CEO','CTO','COO','CFO','Founder','Co-Founder','Engineer','Developer','Designer','Manager','Director','VP','Analyst','Consultant','Researcher','Partner','Investor','Intern','Associate','Lead'];
  DATA.forEach(p => {
    const pos = p.p || '';
    roleKeywords.forEach(r => { if (pos.toLowerCase().includes(r.toLowerCase())) roles.add(r); });
  });
  const roleSelect = document.getElementById('roleFilter');
  roleSelect.innerHTML = '<option value="">All roles</option>';
  [...roles].sort().forEach(role => {
    roleSelect.innerHTML += `<option value="${role}">${role}</option>`;
  });
}

function renderCategoryChips() {
  const CATEGORIES = Categorizer.CATEGORIES;
  const counts = { all: filtered.length };
  DATA.forEach(p => { counts[p._cat] = (counts[p._cat]||0)+1; });

  let html = `<div class="chip ${activeCategory==='all'?'active':''}" data-cat="all">All <span class="chip-count">${DATA.length}</span></div>`;
  for (const [key, cfg] of Object.entries(CATEGORIES)) {
    if (!counts[key]) continue;
    html += `<div class="chip ${activeCategory===key?'active':''}" data-cat="${key}">
      <span class="chip-dot" style="background:${cfg.color}"></span>${cfg.short}
      <span class="chip-count">${counts[key]}</span>
    </div>`;
  }
  document.getElementById('categoryChips').innerHTML = html;
  document.querySelectorAll('.chip').forEach(chip => {
    chip.onclick = () => {
      const cat = chip.dataset.cat;
      if (cat === 'all') { activeCategory = 'all'; resetCameraView(); applyFilters(); }
      else if (activeView === 'graph' && activeCategory !== cat) { activeCategory = cat; renderCategoryChips(); zoomToCluster(cat); }
      else if (activeCategory === cat) { activeCategory = 'all'; resetCameraView(); applyFilters(); }
      else { activeCategory = cat; applyFilters(); }
    };
  });
}

function renderLegend() {
  const CATEGORIES = Categorizer.CATEGORIES;
  let html = '';
  if (clusterMode === 'category' || clusterMode === 'none') {
    const visible = new Set(DATA.map(p => p._cat));
    for (const [key, cfg] of Object.entries(CATEGORIES)) {
      if (!visible.has(key)) continue;
      html += `<div class="legend-item"><div class="legend-dot" style="background:${cfg.color}"></div>${cfg.label}</div>`;
    }
  } else if (clusterMode === 'industry') {
    const industries = [...new Set(DATA.map(p => p._industry))].sort();
    const colors = ['#C0785C','#8B7EC8','#3E7B97','#4A8F72','#C4953A','#7E8EA6','#9B6B8A','#A0A090','#5C6BC0','#26A69A','#EF5350'];
    industries.forEach((ind, i) => {
      html += `<div class="legend-item"><div class="legend-dot" style="background:${colors[i % colors.length]}"></div>${ind}</div>`;
    });
  } else if (clusterMode === 'company') {
    const companyCounts = {};
    DATA.forEach(p => { if (p.c) companyCounts[p.c] = (companyCounts[p.c]||0) + 1; });
    const topCompanies = Object.entries(companyCounts).sort((a,b) => b[1]-a[1]).slice(0, 10);
    topCompanies.forEach(([comp, count]) => {
      html += `<div class="legend-item"><div class="legend-dot" style="background:var(--text)"></div>${comp} (${count})</div>`;
    });
    if (Object.keys(companyCounts).length > 10) {
      html += `<div class="legend-item" style="color:var(--text3)">+ ${Object.keys(companyCounts).length - 10} more</div>`;
    }
  }
  document.getElementById('legend').innerHTML = html;
}

function renderList() {
  const CATEGORIES = Categorizer.CATEGORIES;
  const sorted = [...filtered].sort((a,b) => DataLoader.discoveryScore(b) - DataLoader.discoveryScore(a));
  document.getElementById('listCount').textContent = `${sorted.length} connections`;

  if (!sorted.length) {
    document.getElementById('listArea').innerHTML = '<div class="list-empty">No connections match your filters</div>';
    return;
  }

  let html = '';
  sorted.forEach(p => {
    const cat = CATEGORIES[p._cat];
    const score = DataLoader.discoveryScore(p);
    const scoreClass = score >= 50 ? 'high' : score >= 30 ? 'medium' : '';
    const initials = (p.f[0] || '') + (p.l[0] || '');
    html += `<div class="list-item" data-url="${p.u}">
      <div class="list-avatar" style="background:${cat.color}">${initials}</div>
      <div class="list-info">
        <div class="list-name"><a href="${p.u}" target="_blank">${p.f} ${p.l}</a></div>
        <div class="list-role">${p.p || 'No title'}</div>
        <div class="list-company">${p.c || 'No company'}</div>
        ${p.e ? `<div class="list-email">${p.e}</div>` : ''}
      </div>
      ${p.u ? `<a class="linkedin-badge" href="${p.u}" target="_blank" onclick="event.stopPropagation()" title="Open LinkedIn"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg></a>` : ''}
    </div>`;
  });
  document.getElementById('listArea').innerHTML = html;
}

function renderFullList() {
  const CATEGORIES = Categorizer.CATEGORIES;
  const sorted = [...filtered].sort((a,b) => DataLoader.discoveryScore(b) - DataLoader.discoveryScore(a));
  if (!sorted.length) {
    document.getElementById('listFullView').innerHTML = '<div style="padding:40px;color:var(--text3);text-align:center">No connections match your filters</div>';
    return;
  }

  const tiers = [
    { label: 'High Priority', min: 50, color: '#2E7D32', bg: '#E8F5E9' },
    { label: 'Medium Priority', min: 30, color: '#F57F17', bg: '#FFF8E1' },
    { label: 'Worth Reaching Out', min: 15, color: '#E65100', bg: '#FFF3E0' },
    { label: 'Lower Priority', min: 0, color: '#78909C', bg: '#ECEFF1' },
  ];

  let html = `<div class="list-full-header"><h2>Your Network</h2><span>${sorted.length} connections</span></div>`;
  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    const maxScore = ti === 0 ? Infinity : tiers[ti - 1].min;
    const items = sorted.filter(p => {
      const s = DataLoader.discoveryScore(p);
      return s >= tier.min && s < maxScore;
    });
    if (!items.length) continue;

    html += `<div class="lf-section"><div class="lf-section-title">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tier.color}"></span>
      ${tier.label} <span class="lf-section-count">${items.length}</span>
    </div><div class="list-grid">`;

    items.forEach(p => {
      const cat = CATEGORIES[p._cat];
      const initials = (p.f[0] || '') + (p.l[0] || '');
      const escapedUrl = (p.u || '').replace(/'/g, "\\'");
      html += `<div class="lf-card" onclick="if('${escapedUrl}')window.open('${escapedUrl}','_blank')">
        <div class="lf-avatar" style="background:${cat.color}">${initials}</div>
        <div class="lf-info">
          <div class="lf-name"><a href="${p.u}" target="_blank" onclick="event.stopPropagation()">${p.f} ${p.l}</a></div>
          <div class="lf-role">${p.p || 'No title'}</div>
          <div class="lf-company">${p.c || 'No company'}</div>
          ${p.e ? `<div class="lf-email"><a href="mailto:${p.e}" onclick="event.stopPropagation()">${p.e}</a></div>` : ''}
        </div>
        <div class="lf-meta">
          <div class="lf-cat" style="background:${cat.color}15;color:${cat.color}">${cat.short}</div>
        </div>
      </div>`;
    });
    html += '</div></div>';
  }
  document.getElementById('listFullView').innerHTML = html;
}

function applyFilters() {
  const q = document.getElementById('searchBox').value.toLowerCase();
  activeIndustry = document.getElementById('industryFilter').value;
  activeRole = document.getElementById('roleFilter').value;

  filtered = DATA.filter(p => {
    if (activeCategory !== 'all' && p._cat !== activeCategory) return false;
    if (activeIndustry && p._industry !== activeIndustry) return false;
    if (activeRole && !(p.p || '').toLowerCase().includes(activeRole.toLowerCase())) return false;
    if (q) {
      const hay = `${p.f} ${p.l} ${p.c} ${p.p} ${p.e}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  renderCategoryChips();
  renderLegend();

  const hasFilter = activeCategory !== 'all' || activeIndustry || activeRole || document.getElementById('searchBox').value;
  if (hasFilter && nodeMeshes.length > 0) {
    const filteredSet = new Set(filtered);
    nodeMeshes.forEach(m => {
      const matches = filteredSet.has(m.userData);
      m.material.opacity = matches ? 0.95 : 0.08;
      const s = matches ? 1 : 0.5;
      m.scale.set(s, s, s);
    });
  } else {
    buildGraph();
  }
}

// ─── View switching ───
function setView(view) {
  activeView = view;
  stopAllAnimations();
  hideClusterDetail();

  // Update sidebar nav
  document.querySelectorAll('.sidebar-nav-item').forEach(b => b.classList.remove('active'));
  const navItem = document.querySelector(`.sidebar-nav-item[data-view="${view}"]`);
  if (navItem) navItem.classList.add('active');
  // Legacy toggle support
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.view-btn[data-view="${view}"]`);
  if (btn) btn.classList.add('active');

  // Hide all main content areas
  document.getElementById('canvasWrap').style.display = 'none';
  document.getElementById('chatPage').style.display = 'none';

  // Graph filters only visible when graph is active
  const graphFilters = document.getElementById('graphFilters');
  if (graphFilters) graphFilters.style.display = view === 'graph' ? 'flex' : 'none';

  if (view === 'graph') {
    document.getElementById('canvasWrap').style.display = '';
    if (!renderer || renderer.getContext().isContextLost()) {
      try { initThree(); } catch(e) { console.warn('WebGL re-init failed:', e); }
    }
    onResize();
    nodeMeshes.forEach(m => {
      m.material.opacity = 0.88;
      m.material.emissive = new THREE.Color(0x000000);
      m.material.emissiveIntensity = 0;
      m.scale.setScalar(1);
    });
    activeCategory = 'all';
    renderCategoryChips();
    if (scene) buildGraph();
  } else if (view === 'chat') {
    document.getElementById('chatPage').style.display = 'flex';
    setTimeout(() => document.getElementById('chatPageInput')?.focus(), 100);
  }
}

// ─── Camera animations ───
let _zoomAnimId = null, _pulseAnimId = null, _orbitAnimId = null;

function zoomToCluster(catKey, highlightPerson) {
  if (activeView !== 'graph') return;
  if (_zoomAnimId) cancelAnimationFrame(_zoomAnimId);
  if (_pulseAnimId) cancelAnimationFrame(_pulseAnimId);
  if (_orbitAnimId) cancelAnimationFrame(_orbitAnimId);

  let cx = 0, cy = 0, cz = 0, cn = 0;
  nodeMeshes.forEach((m, i) => {
    if (m.userData._clusterKey === catKey) {
      cx += targetPositions[i].x; cy += targetPositions[i].y; cz += targetPositions[i].z; cn++;
    }
  });
  if (cn === 0) return;
  cx /= cn; cy /= cn; cz /= cn;
  const target = new THREE.Vector3(cx, cy, cz);

  let maxDist = 0;
  nodeMeshes.forEach((m, i) => {
    if (m.userData._clusterKey === catKey) {
      const d = new THREE.Vector3(targetPositions[i].x - cx, targetPositions[i].y - cy, targetPositions[i].z - cz).length();
      if (d > maxDist) maxDist = d;
    }
  });

  const fovRad = camera.fov * Math.PI / 180;
  const zoomDist = Math.max(55, (maxDist * 1.3) / Math.tan(fovRad / 2));
  const offsetAngle = Math.atan2(cx, cz) + 0.4;
  const dest = new THREE.Vector3(cx + Math.sin(offsetAngle) * zoomDist * 0.15, cy + zoomDist * 0.12, cz + zoomDist);

  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const startDist = startPos.distanceTo(startTarget);
  const midDir = new THREE.Vector3().subVectors(dest, startPos).normalize();
  const sideDir = new THREE.Vector3().crossVectors(midDir, new THREE.Vector3(0, 1, 0)).normalize();
  const pullback = new THREE.Vector3().copy(startPos).add(
    new THREE.Vector3().subVectors(startPos, target).normalize().multiplyScalar(startDist * 0.08)
  ).add(new THREE.Vector3(0, startDist * 0.06, 0)).add(sideDir.multiplyScalar(startDist * 0.05));

  const duration = 1800;
  const startTime = performance.now();

  function tweenCamera(now) {
    let t = Math.min((now - startTime) / duration, 1);
    let ease;
    if (t < 0.2) { const t2 = t / 0.2; ease = 0.05 * (t2 * t2); }
    else if (t < 0.7) { const t2 = (t - 0.2) / 0.5; ease = 0.05 + 0.75 * (1 - Math.pow(1 - t2, 2)); }
    else { const t2 = (t - 0.7) / 0.3; ease = 0.8 + 0.2 * (1 - Math.pow(1 - t2, 4)); }

    const oneMinusEase = 1 - ease;
    camera.position.set(
      oneMinusEase * oneMinusEase * startPos.x + 2 * oneMinusEase * ease * pullback.x + ease * ease * dest.x,
      oneMinusEase * oneMinusEase * startPos.y + 2 * oneMinusEase * ease * pullback.y + ease * ease * dest.y,
      oneMinusEase * oneMinusEase * startPos.z + 2 * oneMinusEase * ease * pullback.z + ease * ease * dest.z
    );

    const targetEase = 1 - Math.pow(1 - t, 3);
    controls.target.lerpVectors(startTarget, target, targetEase);
    controls.update();

    const dimProgress = Math.min(t * 2.5, 1);
    nodeMeshes.forEach((m) => {
      const inCluster = m.userData._clusterKey === catKey;
      const isHighlight = highlightPerson && m.userData === highlightPerson;
      if (isHighlight) m.material.opacity = 1;
      else if (inCluster) m.material.opacity = 0.88 + dimProgress * 0.1;
      else m.material.opacity = 0.88 * (1 - dimProgress * 0.88);
    });

    if (t < 1) _zoomAnimId = requestAnimationFrame(tweenCamera);
    else {
      _zoomAnimId = null;
      if (highlightPerson) startPulse(highlightPerson);
      startOrbitDrift(target, zoomDist);
    }
  }
  _zoomAnimId = requestAnimationFrame(tweenCamera);

  nodeMeshes.forEach((m) => {
    if (highlightPerson && m.userData === highlightPerson) {
      m.material.emissive = new THREE.Color(0xffffff);
      m.material.emissiveIntensity = 0.25;
      m.scale.set(2, 2, 2);
    } else {
      m.material.emissive = new THREE.Color(0x000000);
      m.material.emissiveIntensity = 0;
    }
  });

  if (Categorizer.CATEGORIES[catKey]) { activeCategory = catKey; renderCategoryChips(); }
  showClusterDetail(catKey, highlightPerson);
}

function startPulse(highlightPerson) {
  const startTime = performance.now();
  function pulse(now) {
    const elapsed = now - startTime;
    const breathe = 0.15 + Math.sin(elapsed * 0.003) * 0.12;
    const scalePulse = 1.8 + Math.sin(elapsed * 0.004) * 0.2;
    nodeMeshes.forEach(m => {
      if (m.userData === highlightPerson) {
        m.material.emissiveIntensity = breathe;
        m.scale.setScalar(scalePulse);
      }
    });
    _pulseAnimId = requestAnimationFrame(pulse);
  }
  _pulseAnimId = requestAnimationFrame(pulse);
}

function startOrbitDrift(center, radius) {
  if (_orbitAnimId) cancelAnimationFrame(_orbitAnimId);
  const startTime = performance.now();
  const startPos = camera.position.clone();
  const dx = startPos.x - center.x, dz = startPos.z - center.z;
  const startAngle = Math.atan2(dx, dz);
  const orbitRadius = Math.sqrt(dx * dx + dz * dz);
  const orbitY = startPos.y;
  const speed = (2 * Math.PI) / 60000;

  function drift(now) {
    const elapsed = now - startTime;
    const angle = startAngle + elapsed * speed;
    const yBob = Math.sin(elapsed * 0.0008) * 3;
    camera.position.set(center.x + Math.sin(angle) * orbitRadius, orbitY + yBob, center.z + Math.cos(angle) * orbitRadius);
    controls.target.copy(center);
    controls.update();
    _orbitAnimId = requestAnimationFrame(drift);
  }
  _orbitAnimId = requestAnimationFrame(drift);
}

function stopAllAnimations() {
  if (_zoomAnimId) { cancelAnimationFrame(_zoomAnimId); _zoomAnimId = null; }
  if (_pulseAnimId) { cancelAnimationFrame(_pulseAnimId); _pulseAnimId = null; }
  if (_orbitAnimId) { cancelAnimationFrame(_orbitAnimId); _orbitAnimId = null; }
}

function resetCameraView() {
  stopAllAnimations();
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const dest = new THREE.Vector3(0, 40, 700);
  const targetCenter = new THREE.Vector3(0, 0, 0);
  const midUp = new THREE.Vector3(startPos.x * 0.5, Math.max(startPos.y, 50) + 80, startPos.z * 0.5 + 100);
  const duration = 1400;
  const startTime = performance.now();
  const startOpacities = nodeMeshes.map(m => m.material.opacity);

  function tweenBack(now) {
    let t = Math.min((now - startTime) / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const oneMinusEase = 1 - ease;
    camera.position.set(
      oneMinusEase * oneMinusEase * startPos.x + 2 * oneMinusEase * ease * midUp.x + ease * ease * dest.x,
      oneMinusEase * oneMinusEase * startPos.y + 2 * oneMinusEase * ease * midUp.y + ease * ease * dest.y,
      oneMinusEase * oneMinusEase * startPos.z + 2 * oneMinusEase * ease * midUp.z + ease * ease * dest.z
    );
    controls.target.lerpVectors(startTarget, targetCenter, ease);
    controls.update();
    nodeMeshes.forEach((m, i) => {
      m.material.opacity = startOpacities[i] + (0.88 - startOpacities[i]) * ease;
      m.material.emissive = new THREE.Color(0x000000);
      m.material.emissiveIntensity = 0;
      const currentScale = m.scale.x;
      m.scale.setScalar(currentScale + (1 - currentScale) * ease);
    });
    if (t < 1) _zoomAnimId = requestAnimationFrame(tweenBack);
    else {
      _zoomAnimId = null;
      nodeMeshes.forEach(m => { m.material.opacity = 0.88; m.material.emissive = new THREE.Color(0x000000); m.material.emissiveIntensity = 0; m.scale.setScalar(1); });
    }
  }
  _zoomAnimId = requestAnimationFrame(tweenBack);
  activeCategory = 'all';
  renderCategoryChips();
  hideClusterDetail();
}

function showClusterDetail(catKey, highlightPerson) {
  const CATEGORIES = Categorizer.CATEGORIES;
  const people = filtered.filter(p => p._clusterKey === catKey || (clusterMode === 'category' && p._cat === catKey));
  const sorted = people.sort((a,b) => DataLoader.discoveryScore(b) - DataLoader.discoveryScore(a));
  const cat = CATEGORIES[catKey];
  const label = cat ? cat.label : catKey;
  const color = cat ? cat.color : '#191918';

  let html = `<div class="detail-header">
    <button class="detail-close" onclick="resetCameraView()" title="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
    <button class="detail-back" onclick="resetCameraView()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      Back to all
    </button>
    <h2 style="color:${color}">${label}</h2>
    <span class="detail-count">${sorted.length} people</span>
  </div><div class="detail-list">`;

  sorted.forEach((p) => {
    const pcat = CATEGORIES[p._cat];
    const initials = (p.f[0] || '') + (p.l[0] || '');
    const isHighlighted = highlightPerson && p.f === highlightPerson.f && p.l === highlightPerson.l && p.u === highlightPerson.u;
    html += `<div class="detail-card${isHighlighted ? ' detail-card-highlight' : ''}" id="${isHighlighted ? 'detail-highlight-target' : ''}">
      <div class="lf-avatar" style="background:${pcat.color};width:32px;height:32px;font-size:11px">${initials}</div>
      <div class="lf-info">
        <div class="lf-name" style="font-size:13px">${p.f} ${p.l}</div>
        <div class="lf-role">${p.p || 'No title'}</div>
        <div class="lf-company">${p.c || ''}</div>
        ${p.e ? `<div class="lf-email">${p.e}</div>` : ''}
      </div>
      ${p.u ? `<a class="linkedin-badge" href="${p.u}" target="_blank" onclick="event.stopPropagation()" title="Open LinkedIn" style="align-self:center">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
      </a>` : ''}
    </div>`;
  });
  html += '</div>';

  const panel = document.getElementById('detailPanel');
  panel.innerHTML = html;
  panel.classList.add('visible');
  if (highlightPerson) {
    setTimeout(() => {
      const el = document.getElementById('detail-highlight-target');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }
}

function hideClusterDetail() {
  document.getElementById('detailPanel').classList.remove('visible');
}

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ─── Init ───
async function initApp(data) {
  // Load categorization cache
  Categorizer.loadCache();

  DATA = data.map(p => ({
    ...p,
    _cat: Categorizer.categorize(p),
    _industry: DataLoader.classifyIndustry(p),
  }));
  filtered = [...DATA];

  try { initThree(); } catch(e) { console.warn('WebGL init failed:', e); }
  populateFilters();
  applyFilters();
  if (renderer) { animate(); onResize(); }

  // Default to chat view
  setView('chat');

  // Show API key modal
  Modal.show(async (aiConnected) => {
    // Init chat immediately (works with or without AI)
    ChatUI.init(DATA);

    if (aiConnected) {
      // Run AI categorization in background — live-update graph on each batch
      _showCategorizationProgress();
      const changed = await Categorizer.aiCategorizeAll(DATA, (done, total) => {
        _updateCategorizationProgress(done, total);
        ChatUI.updateClassificationStatus(done, total);
        // Live-update graph & chips after each batch
        renderCategoryChips();
        applyFilters();
        if (activeView === 'graph') buildGraph();
      });
      _hideCategorizationProgress();
      ChatUI.finishClassification();
      renderCategoryChips();
      applyFilters();
      buildGraph();
      ChatUI.refreshData(DATA);
    }
  });
}

function _showCategorizationProgress() {
  const bar = document.createElement('div');
  bar.id = 'aiProgress';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;background:var(--border);z-index:9999;';
  bar.innerHTML = '<div id="aiProgressBar" style="height:100%;background:var(--text);width:0%;transition:width 0.3s"></div>';
  document.body.appendChild(bar);

  const label = document.createElement('div');
  label.id = 'aiProgressLabel';
  label.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 14px;font-size:11px;color:var(--text2);box-shadow:0 2px 12px rgba(0,0,0,0.08);';
  label.textContent = 'AI categorizing contacts...';
  document.body.appendChild(label);
}

function _updateCategorizationProgress(done, total) {
  const bar = document.getElementById('aiProgressBar');
  const label = document.getElementById('aiProgressLabel');
  if (bar) bar.style.width = `${(done / total) * 100}%`;
  if (label) label.textContent = `AI categorizing... ${done}/${total}`;
}

function _hideCategorizationProgress() {
  const bar = document.getElementById('aiProgress');
  const label = document.getElementById('aiProgressLabel');
  if (bar) setTimeout(() => bar.remove(), 500);
  if (label) setTimeout(() => label.remove(), 500);
}

// ─── Event Listeners ───
document.getElementById('searchBox').addEventListener('input', debounce(applyFilters, 200));
document.getElementById('industryFilter').addEventListener('change', applyFilters);
document.getElementById('roleFilter').addEventListener('change', applyFilters);
document.querySelectorAll('.priority-controls input').forEach(cb => {
  cb.addEventListener('change', () => { applyFilters(); });
});
document.querySelectorAll('.view-btn').forEach(btn => {
  btn.onclick = () => setView(btn.dataset.view);
});
document.querySelectorAll('.sidebar-nav-item').forEach(item => {
  item.onclick = () => setView(item.dataset.view);
});
// Graph toggle button
const graphToggleBtn = document.getElementById('graphToggleBtn');
if (graphToggleBtn) {
  graphToggleBtn.onclick = () => {
    if (activeView === 'graph') {
      setView('chat');
      graphToggleBtn.classList.remove('active');
    } else {
      setView('graph');
      graphToggleBtn.classList.add('active');
    }
  };
}
document.querySelectorAll('.cluster-btn').forEach(btn => {
  btn.onclick = () => {
    stopAllAnimations();
    hideClusterDetail();
    document.querySelectorAll('.cluster-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    clusterMode = btn.dataset.mode;
    activeCategory = 'all';
    renderCategoryChips();
    renderLegend();
    nodeMeshes.forEach(m => {
      m.material.opacity = 0.88;
      m.material.emissive = new THREE.Color(0x000000);
      m.material.emissiveIntensity = 0;
      m.scale.setScalar(1);
    });
    buildGraph();
  };
});

// Header settings button
document.getElementById('settingsBtn')?.addEventListener('click', () => {
  Modal.showSettings();
});

// Panel collapse/expand
document.getElementById('panelCollapseBtn')?.addEventListener('click', () => {
  const panel = document.getElementById('sidePanel');
  const expandBtn = document.getElementById('panelExpandBtn2');
  panel.classList.add('collapsed');
  expandBtn.style.display = 'flex';
  setTimeout(() => onResize(), 300);
});
document.getElementById('panelExpandBtn2')?.addEventListener('click', () => {
  const panel = document.getElementById('sidePanel');
  const expandBtn = document.getElementById('panelExpandBtn2');
  panel.classList.remove('collapsed');
  expandBtn.style.display = 'none';
  setTimeout(() => onResize(), 300);
});

// ─── Load CSV ───
function _saveCSVToStorage(csvText) {
  try { localStorage.setItem('connections_csv', csvText); }
  catch (e) { console.warn('Failed to save CSV to localStorage:', e); }
}

function _loadCSVFromStorage() {
  try { return localStorage.getItem('connections_csv') || null; }
  catch { return null; }
}

function loadCSVFromFile(file, onDone) {
  const reader = new FileReader();
  reader.onload = function(ev) {
    const text = ev.target.result;
    const data = DataLoader.parseCSV(text);
    if (data.length) {
      _saveCSVToStorage(text);
      if (onDone) onDone(data);
      else initApp(data);
    } else {
      alert('No data found in CSV.');
    }
  };
  reader.readAsText(file);
}

function loadCSV() {
  // 1. Try localStorage first
  const cached = _loadCSVFromStorage();
  if (cached) {
    const data = DataLoader.parseCSV(cached);
    if (data.length) { initApp(data); return; }
  }

  // 2. Try fetching Connections.csv from server
  fetch('Connections.csv')
    .then(r => { if (r.ok) return r.text(); throw new Error('not found'); })
    .then(text => {
      const data = DataLoader.parseCSV(text);
      if (data.length) {
        _saveCSVToStorage(text);
        initApp(data);
      } else {
        // No data in file — start empty, settings modal handles CSV upload
        initApp([]);
      }
    })
    .catch(() => {
      // No CSV file found — start empty, settings modal handles CSV upload
      initApp([]);
    });
}
loadCSV();
