// Resolved through the import map in stl-teklif.html.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { unzipSync, strFromU8 } from "three/addons/libs/fflate.module.js";

const viewer = document.querySelector("#stl-viewer");
const input = document.querySelector("#stl-file");
const dropZone = document.querySelector("#stl-drop");
const fileNameEl = document.querySelector("#stl-file-name");
const dimensionsEl = document.querySelector("#stl-dimensions");
const volumeEl = document.querySelector("#stl-volume");
const priceEl = document.querySelector("#stl-price");
const breakdownEl = document.querySelector("#stl-breakdown");
const stepsEl = document.querySelector("#stl-steps");
const panels = [...document.querySelectorAll(".stl-panel")];
const prevButton = document.querySelector("#stl-prev");
const nextButton = document.querySelector("#stl-next");
const quantityInput = document.querySelector("#stl-quantity");
const quoteForm = document.querySelector("#stl-quote-form");
const formMessage = document.querySelector("#stl-form-message");
const partsEl = document.querySelector("#stl-parts");
const colorsEl = document.querySelector("#stl-colors");
const applyAllButton = document.querySelector("#stl-apply-all");
const paintedWarning = document.querySelector("#stl-painted-warning");

const DEFAULT_HEX = "#ff6542";
const INFILL_OPTIONS = [
  { value: 15, label: "%15", note: "Dekoratif, hafif" },
  { value: 30, label: "%30", note: "Genel kullanım" },
  { value: 50, label: "%50", note: "Dayanıklı" },
  { value: 100, label: "%100", note: "Katı, en sağlam" }
];
// Welding every vertex of a huge mesh costs more than the feature is worth;
// past this the model is treated as a single part.
const MAX_TRIANGLES_TO_SPLIT = 400000;
const LAST_STEP = 5;

const money = (value) => `${Number(value || 0).toFixed(2)} TL`;
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));

// The upload step's feedback card. Hidden until there is something to say, so an
// untouched step 1 shows the dropzone alone instead of an empty grey box.
function setFileNote(html, isError) {
  if (!fileNameEl) return;
  fileNameEl.hidden = false;
  fileNameEl.innerHTML = html;
  fileNameEl.classList.toggle("stl-file-card--error", Boolean(isError));
  dropZone?.classList.toggle("has-file", !isError);
}

const quote = {
  file: null,
  width: 0,
  height: 0,
  depth: 0,
  maxDim: 0,
  volumeCm3: 0,
  parts: [],          // { index, volumeCm3, colorId, colorName, hex, mesh }
  materialId: null,
  infill: 30,
  quantity: 1
};

let palette = [];
let selectedPart = 0;
let step = 1;
let scene;
let camera;
let renderer;
let controls;
let group;
let plate;

/* ---------- viewer ---------- */

function initViewer() {
  if (!viewer || renderer) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfff8f3);

  camera = new THREE.PerspectiveCamera(45, viewer.clientWidth / viewer.clientHeight, 0.1, 10000);
  camera.position.set(120, 110, 140);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(viewer.clientWidth, viewer.clientHeight);
  viewer.replaceChildren(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd7c4b8, 2.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(130, 180, 120);
  scene.add(keyLight);

  buildPlate(180);

  renderer.domElement.addEventListener("pointerdown", pickPart);
  window.addEventListener("resize", resizeViewer);
  animate();
}

// A real build plate at y = 0, so the model has something to stand on.
function buildPlate(size) {
  if (plate) scene.remove(plate);
  plate = new THREE.Group();

  const surface = new THREE.Mesh(
    new THREE.BoxGeometry(size, 2, size),
    new THREE.MeshStandardMaterial({ color: 0xf3e4da, roughness: 0.9, metalness: 0 })
  );
  surface.position.y = -1;   // top face sits exactly on y = 0
  plate.add(surface);

  const grid = new THREE.GridHelper(size, Math.max(8, Math.round(size / 10)), 0xffb199, 0xe8d3c6);
  grid.position.y = 0.02;    // just above the surface, so it does not z-fight
  plate.add(grid);

  scene.add(plate);
}

function resizeViewer() {
  if (!renderer || !viewer) return;
  camera.aspect = viewer.clientWidth / viewer.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewer.clientWidth, viewer.clientHeight);
}

// No auto-rotation: the model sits still on the plate and the customer orbits it.
function animate() {
  requestAnimationFrame(animate);
  controls?.update();
  renderer?.render(scene, camera);
}

/* ---------- splitting the STL into separate parts ----------
   An STL is a bag of triangles with no notion of "objects". Triangles that
   share vertices form one solid; a group that shares none with the rest is a
   separate part. So: weld coincident vertices, union-find over the triangles,
   and every connected component becomes its own mesh the customer can colour. */

function splitIntoParts(geometry) {
  const position = geometry.attributes.position;
  const triangleCount = Math.floor(position.count / 3);
  if (triangleCount > MAX_TRIANGLES_TO_SPLIT) return [geometry];

  // Weld: quantise coordinates so that vertices duplicated per-triangle collapse.
  const ids = new Int32Array(position.count);
  const seen = new Map();
  let vertexCount = 0;
  for (let i = 0; i < position.count; i += 1) {
    const key = `${Math.round(position.getX(i) * 1e4)},${Math.round(position.getY(i) * 1e4)},${Math.round(position.getZ(i) * 1e4)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = vertexCount;
      vertexCount += 1;
      seen.set(key, id);
    }
    ids[i] = id;
  }

  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i;

  const find = (value) => {
    let x = value;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let t = 0; t < triangleCount; t += 1) {
    union(ids[t * 3], ids[t * 3 + 1]);
    union(ids[t * 3 + 1], ids[t * 3 + 2]);
  }

  const groups = new Map();
  for (let t = 0; t < triangleCount; t += 1) {
    const root = find(ids[t * 3]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }

  if (groups.size <= 1) return [geometry];

  const source = position.array;
  return [...groups.values()].map((triangles) => {
    const vertices = new Float32Array(triangles.length * 9);
    triangles.forEach((triangle, index) => {
      vertices.set(source.subarray(triangle * 9, triangle * 9 + 9), index * 9);
    });
    const partGeometry = new THREE.BufferGeometry();
    partGeometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    return partGeometry;
  });
}

function volumeOf(geometry) {
  const position = geometry.attributes.position;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;

  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    volume += a.dot(b.cross(c)) / 6;
  }

  return Math.abs(volume);
}

/* ---------- 3MF ----------
   A 3MF is a zip of XML. three's stock loader cannot read the ones MakerWorld /
   Bambu Studio produce: those use the *production extension*, where the root
   3dmodel.model holds no geometry at all — its objects are `<component>`
   references into other .model files inside the zip. The loader looks for a
   <mesh> that isn't there and dies with "Cannot read properties of undefined".

   So we parse it ourselves. Each component is one printable part, and its colour
   comes from Bambu's own metadata: model_settings.config maps each part to an
   extruder number, and project_settings.config lists the filament colour loaded
   in each extruder. That is where the dragon's green body and black eyes live. */

const TRANSFORM_IDENTITY = new THREE.Matrix4();

// 3MF stores a 4x3 matrix in row-vector order: 3 basis rows, then translation.
function parseTransform(value) {
  if (!value) return TRANSFORM_IDENTITY.clone();
  const n = value.trim().split(/\s+/).map(Number);
  if (n.length < 12 || n.some(Number.isNaN)) return TRANSFORM_IDENTITY.clone();
  return new THREE.Matrix4().set(
    n[0], n[3], n[6], n[9],
    n[1], n[4], n[7], n[10],
    n[2], n[5], n[8], n[11],
    0, 0, 0, 1
  );
}

// Regex rather than DOMParser: these mesh files reach 20 MB and hundreds of
// thousands of triangles, and building a DOM node per vertex is far too slow.
function parseMeshObjects(xml) {
  const objects = new Map();
  const objectRe = /<object\s+([^>]*?)>([\s\S]*?)<\/object>/g;
  let match;

  while ((match = objectRe.exec(xml))) {
    const id = (match[1].match(/\bid="([^"]+)"/) || [])[1];
    const body = match[2];
    if (!id || !body.includes("<triangle")) continue;

    const coords = [];
    const vertexRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
    let vertex;
    while ((vertex = vertexRe.exec(body))) {
      coords.push(Number(vertex[1]), Number(vertex[2]), Number(vertex[3]));
    }

    const triangleRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"([^>]*)>?/g;
    const indices = [];
    let painted = false;
    let triangle;
    while ((triangle = triangleRe.exec(body))) {
      indices.push(Number(triangle[1]), Number(triangle[2]), Number(triangle[3]));
      if (!painted && /paint_color|mmu_segmentation/.test(triangle[4])) painted = true;
    }

    // Non-indexed, the way the rest of the pipeline (volume, STL export) expects.
    const positions = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i += 1) {
      positions[i * 3] = coords[indices[i] * 3];
      positions[i * 3 + 1] = coords[indices[i] * 3 + 1];
      positions[i * 3 + 2] = coords[indices[i] * 3 + 2];
    }

    objects.set(id, { positions, painted });
  }

  return objects;
}

// model_settings.config: object -> parts -> { name, extruder }
function parseBambuSettings(xml) {
  const byObject = new Map();
  if (!xml) return byObject;

  const objectRe = /<object\s+id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g;
  let objectMatch;
  while ((objectMatch = objectRe.exec(xml))) {
    const parts = new Map();
    const partRe = /<part\s+id="(\d+)"[^>]*>([\s\S]*?)<\/part>/g;
    let partMatch;
    while ((partMatch = partRe.exec(objectMatch[2]))) {
      const body = partMatch[2];
      parts.set(partMatch[1], {
        name: (body.match(/key="name"\s+value="([^"]*)"/) || [])[1] || null,
        extruder: Number((body.match(/key="extruder"\s+value="(\d+)"/) || [])[1]) || null
      });
    }
    byObject.set(objectMatch[1], parts);
  }

  return byObject;
}

function parse3mf(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const read = (name) => (zip[name] ? strFromU8(zip[name]) : null);
  const clean = (name) => name.replace(/^\//, "");

  const rels = read("_rels/.rels") || "";
  const rootPath = clean((rels.match(/Target="([^"]*3dmodel\.model)"/i) || [])[1] || "/3D/3dmodel.model");
  const rootXml = read(rootPath);
  if (!rootXml) throw new Error("3MF içinde model dosyası bulunamadı.");

  // Filament colours, keyed by extruder number.
  let filaments = [];
  try {
    filaments = JSON.parse(read("Metadata/project_settings.config") || "{}").filament_colour || [];
  } catch {
    filaments = [];
  }
  const settings = parseBambuSettings(read("Metadata/model_settings.config"));

  const meshCache = new Map();
  const meshesIn = (modelPath) => {
    if (!meshCache.has(modelPath)) {
      const xml = read(modelPath);
      meshCache.set(modelPath, xml ? parseMeshObjects(xml) : new Map());
    }
    return meshCache.get(modelPath);
  };

  // Objects declared in the root file (they hold the <component> lists).
  const rootObjects = new Map();
  const objectRe = /<object\s+([^>]*?)>([\s\S]*?)<\/object>/g;
  let objectMatch;
  while ((objectMatch = objectRe.exec(rootXml))) {
    const id = (objectMatch[1].match(/\bid="([^"]+)"/) || [])[1];
    if (id) rootObjects.set(id, objectMatch[2]);
  }
  const rootMeshes = parseMeshObjects(rootXml);

  const pieces = [];
  let painted = false;

  const addPiece = (positions, matrix, name, extruder) => {
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
    geometry.applyMatrix4(matrix);
    const hex = extruder && filaments[extruder - 1] ? filaments[extruder - 1].slice(0, 7) : null;
    pieces.push({ geometry, name: name || null, fileColor: hex });
  };

  const itemRe = /<item\s+([^>]*?)\/?>/g;
  let itemMatch;
  while ((itemMatch = itemRe.exec(rootXml))) {
    const attrs = itemMatch[1];
    const objectId = (attrs.match(/objectid="([^"]+)"/) || [])[1];
    if (!objectId) continue;
    const itemMatrix = parseTransform((attrs.match(/transform="([^"]+)"/) || [])[1]);
    const partSettings = settings.get(objectId) || new Map();
    const body = rootObjects.get(objectId) || "";

    // Case 1 — production extension: the object is a list of components.
    const componentRe = /<component\s+([^>]*?)\/?>/g;
    let componentMatch;
    let found = false;
    while ((componentMatch = componentRe.exec(body))) {
      found = true;
      const componentAttrs = componentMatch[1];
      const childId = (componentAttrs.match(/objectid="([^"]+)"/) || [])[1];
      const childPath = (componentAttrs.match(/p:path="([^"]+)"/) || [])[1];
      const meshes = childPath ? meshesIn(clean(childPath)) : rootMeshes;
      const mesh = meshes.get(childId);
      if (!mesh) continue;
      if (mesh.painted) painted = true;

      const matrix = itemMatrix.clone()
        .multiply(parseTransform((componentAttrs.match(/transform="([^"]+)"/) || [])[1]));
      const info = partSettings.get(childId) || {};
      addPiece(mesh.positions, matrix, info.name, info.extruder);
    }

    // Case 2 — a plain object that carries its own mesh.
    if (!found) {
      const mesh = rootMeshes.get(objectId);
      if (!mesh) continue;
      if (mesh.painted) painted = true;
      const info = partSettings.get(objectId) || {};
      addPiece(mesh.positions, itemMatrix, info.name, info.extruder);
    }
  }

  if (!pieces.length) throw new Error("3MF içinde okunabilir nesne bulunamadı.");
  return { pieces, painted };
}

function nearestPaletteColor(hex) {
  if (!hex || !palette.length) return null;
  const target = new THREE.Color(hex);
  let best = null;
  let bestDistance = Infinity;
  palette.forEach((item) => {
    const candidate = new THREE.Color(item.hex);
    const distance =
      (candidate.r - target.r) ** 2 + (candidate.g - target.g) ** 2 + (candidate.b - target.b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  });
  return best;
}

function loadModel(file) {
  initViewer();
  const reader = new FileReader();
  reader.onload = () => {
    const buffer = reader.result;
    const is3mf = file.name.toLowerCase().endsWith(".3mf");
    let pieces;
    let painted = false;

    try {
      if (is3mf) {
        const parsed = parse3mf(buffer);
        pieces = parsed.pieces;
        painted = parsed.painted;
      } else {
        const whole = new STLLoader().parse(buffer);
        pieces = splitIntoParts(whole).map((geometry) => ({ geometry, name: null, fileColor: null }));
      }
    } catch (error) {
      setFileNote(`<strong>Dosya okunamadı</strong><span>${escapeHtml(error.message)}</span>`, true);
      return;
    }

    if (!pieces.length) {
      setFileNote("<strong>Dosyada model bulunamadı</strong><span>Başka bir STL veya 3MF deneyin.</span>", true);
      return;
    }

    // STL and 3MF are Z-up; three.js is Y-up. Bake the conversion into the
    // geometry, otherwise the model stands perpendicular to the plate.
    const zUpToYUp = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    pieces.forEach(({ geometry }) => geometry.applyMatrix4(zUpToYUp));

    // Measure the whole model before splitting responsibilities per part.
    const bounds = new THREE.Box3();
    pieces.forEach(({ geometry }) => {
      geometry.computeBoundingBox();
      bounds.union(geometry.boundingBox);
    });
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    bounds.getSize(size);
    bounds.getCenter(center);

    // Centre on the plate horizontally, and drop it so the lowest point rests at
    // y = 0 — the model stands on the plate instead of floating through it.
    const offset = new THREE.Vector3(-center.x, -bounds.min.y, -center.z);

    if (group) scene.remove(group);
    group = new THREE.Group();

    // Biggest part first, so "Parça 1" is the one the customer thinks of first.
    const sorted = pieces
      .map((piece) => ({ ...piece, volume: volumeOf(piece.geometry) }))
      .sort((a, b) => b.volume - a.volume);

    quote.parts = sorted.map((piece, index) => {
      // The same offset for every part — that is what keeps them aligned.
      piece.geometry.translate(offset.x, offset.y, offset.z);
      piece.geometry.computeVertexNormals();

      const fromFile = nearestPaletteColor(piece.fileColor);
      const chosen = fromFile || palette[index % Math.max(1, palette.length)] || null;
      const hex = chosen?.hex || DEFAULT_HEX;

      const mesh = new THREE.Mesh(
        piece.geometry,
        new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.55, metalness: 0.08 })
      );
      mesh.userData.partIndex = index;
      group.add(mesh);

      return {
        index,
        name: piece.name,
        volumeCm3: piece.volume / 1000,
        colorId: chosen?.id || null,
        colorName: chosen?.name || null,
        hex,
        matchedFromFile: Boolean(fromFile),
        mesh
      };
    });

    scene.add(group);

    // After the Z-up conversion: x = width, z = depth, y = print height.
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const footprint = Math.max(size.x, size.z);
    buildPlate(Math.max(120, Math.ceil((footprint * 1.15) / 20) * 20));

    // Frame the whole bounding sphere, not just the longest edge — a wide plate
    // with two models would otherwise sit tiny in the middle of the viewport.
    const radius = (size.length() / 2) || 1;
    const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.02;
    camera.position.set(distance * 0.6, distance * 0.5 + size.y / 2, distance * 0.75);
    camera.near = Math.max(0.1, distance / 200);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, size.y / 2, 0);
    controls.update();

    quote.file = file;
    quote.width = size.x;
    quote.depth = size.z;
    quote.height = size.y;
    quote.maxDim = maxDim;
    quote.volumeCm3 = quote.parts.reduce((sum, part) => sum + part.volumeCm3, 0);

    const count = quote.parts.length;
    const partNote = count > 1 ? `${count} parça` : "Tek parça";
    const dims = `${size.x.toFixed(1)} x ${size.z.toFixed(1)} x ${size.y.toFixed(1)} mm`;
    const sizeMb = file.size / (1024 * 1024);
    setFileNote(`
      <span class="stl-file-card__tick" aria-hidden="true">✓</span>
      <span class="stl-file-card__body">
        <strong>${escapeHtml(file.name)}</strong>
        <span class="stl-file-card__meta">
          <i>${dims}</i><i>${partNote}</i><i>${sizeMb < 0.1 ? "<0.1" : sizeMb.toFixed(1)} MB</i>
        </span>
      </span>
      <span class="stl-file-card__change">Değiştir</span>`);
    dimensionsEl.textContent = dims;
    volumeEl.textContent = `${quote.volumeCm3.toFixed(2)} cm3`;

    // Painted 3MFs carry colour per triangle, not per object. We cannot read those
    // regions, so say so — silently showing the wrong colours would be worse.
    paintedWarning.hidden = !painted;
    quote.painted = painted;

    selectedPart = 0;
    renderParts();
    updateNav();
    refreshPrice();
  };
  reader.readAsArrayBuffer(file);
}

/* ---------- part selection & colouring ---------- */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function pickPart(event) {
  if (!group || quote.parts.length < 2) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(group.children, false)[0];
  if (!hit) return;
  selectedPart = hit.object.userData.partIndex;
  renderParts();
}

function renderParts() {
  partsEl.innerHTML = quote.parts.map((part) => `
    <button type="button" class="stl-part ${part.index === selectedPart ? "is-selected" : ""}" data-part="${part.index}">
      <span class="stl-part__dot" style="background:${part.hex}"></span>
      <span class="stl-part__body">
        <strong>${part.name || `Parça ${part.index + 1}`}</strong>
        <small>
          ${part.volumeCm3.toFixed(2)} cm³ · ${part.colorName || "renk seçilmedi"}${part.matchedFromFile ? " · dosyadan okundu" : ""}
        </small>
      </span>
    </button>
  `).join("");

  updatePartsFade();

  // Highlight by making the selected part glow, not by fading the rest — with 40+
  // parts, dimming everything else washes the whole model out.
  quote.parts.forEach((part) => {
    const selected = part.index === selectedPart && quote.parts.length > 1;
    part.mesh.material.emissive.set(selected ? 0xff6542 : 0x000000);
    part.mesh.material.emissiveIntensity = selected ? 0.35 : 0;
  });

  colorsEl.querySelectorAll("input").forEach((radio) => {
    radio.checked = Number(radio.value) === quote.parts[selectedPart]?.colorId;
  });
}

partsEl.addEventListener("click", (event) => {
  const button = event.target.closest(".stl-part");
  if (!button) return;
  selectedPart = Number(button.dataset.part);
  renderParts();
});

function paintPart(partIndex, color) {
  const part = quote.parts[partIndex];
  if (!part) return;
  part.colorId = color.id;
  part.colorName = color.name;
  part.hex = color.hex;
  part.mesh.material.color.set(color.hex);
}

colorsEl.addEventListener("change", (event) => {
  const color = palette.find((item) => item.id === Number(event.target.value));
  if (!color) return;
  paintPart(selectedPart, color);
  renderParts();
  refreshPrice();   // colour count feeds the price
});

applyAllButton.addEventListener("click", () => {
  const color = palette.find((item) => item.id === quote.parts[selectedPart]?.colorId);
  if (!color) return;
  quote.parts.forEach((part) => paintPart(part.index, color));
  renderParts();
  refreshPrice();
});

/* ---------- wizard ---------- */

// Drives the parts list's bottom fade: only a list that actually scrolls gets one.
// Must run while the panel is visible — a display:none panel measures 0 x 0.
function updatePartsFade() {
  if (!partsEl) return;
  partsEl.classList.toggle("is-scrollable", partsEl.scrollHeight > partsEl.clientHeight);
}

function showStep(next) {
  step = Math.min(LAST_STEP, Math.max(1, next));
  panels.forEach((panel) => panel.classList.toggle("is-active", Number(panel.dataset.step) === step));
  [...stepsEl.children].forEach((item) => {
    const itemStep = Number(item.dataset.step);
    item.classList.toggle("is-active", itemStep === step);
    item.classList.toggle("is-done", itemStep < step);
  });
  updateNav();
  updatePartsFade();
}

function canLeaveStep(current) {
  if (current === 1) return Boolean(quote.file);
  if (current === 2) return Boolean(quote.materialId);
  return true;
}

function updateNav() {
  prevButton.disabled = step === 1;
  nextButton.disabled = !canLeaveStep(step);
  nextButton.hidden = step === LAST_STEP;
}

prevButton.addEventListener("click", () => showStep(step - 1));
nextButton.addEventListener("click", () => {
  if (canLeaveStep(step)) showStep(step + 1);
});

stepsEl.addEventListener("click", (event) => {
  const item = event.target.closest("li");
  if (!item) return;
  const target = Number(item.dataset.step);
  for (let i = 1; i < target; i += 1) {
    if (!canLeaveStep(i)) return;
  }
  showStep(target);
});

// One entry point for both the file picker and a drag-and-drop, so the extension
// check can never be bypassed by dropping instead of clicking.
function acceptFile(file) {
  if (!file) return;
  if (!/\.(stl|3mf)$/i.test(file.name)) {
    setFileNote("<strong>Bu dosya türü desteklenmiyor</strong><span>Yalnızca .stl ve .3mf dosyaları yüklenebilir.</span>", true);
    if (input) input.value = "";
    return;
  }
  loadModel(file);
}

input?.addEventListener("change", (event) => acceptFile(event.target.files?.[0]));

// A drop never populates input.files, but nothing downstream reads it — the
// submit sends quote.file, which loadModel() sets either way.
if (dropZone) {
  ["dragenter", "dragover"].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  }));
  ["dragleave", "dragend"].forEach((type) => dropZone.addEventListener(type, () => {
    dropZone.classList.remove("is-dragging");
  }));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    acceptFile(event.dataTransfer?.files?.[0]);
  });
  // The card sits outside the <label>, so "Değiştir" has to open the picker itself.
  fileNameEl?.addEventListener("click", () => input?.click());
}

// Dropping a file anywhere else must not make the browser navigate to it.
["dragover", "drop"].forEach((type) => window.addEventListener(type, (event) => {
  if (!event.target.closest?.("#stl-drop")) event.preventDefault();
}));

/* ---------- admin-managed options ---------- */

async function loadOptions() {
  const [materials, colors] = await Promise.all([
    fetch("/api/materials").then((response) => response.json()).catch(() => []),
    fetch("/api/colors").then((response) => response.json()).catch(() => [])
  ]);
  palette = colors;

  document.querySelector("#stl-materials").innerHTML = materials.map((item) => `
    <label class="stl-option">
      <input type="radio" name="material" value="${item.id}">
      <span class="stl-option__body">
        <strong>${item.name}</strong>
        <small>${item.description || ""}</small>
      </span>
      <span class="stl-option__price">${money(item.price_per_cm3)}/cm³</span>
    </label>
  `).join("") || "<p>Malzeme tanımlı değil.</p>";

  colorsEl.innerHTML = colors.map((item) => `
    <label class="stl-swatch" title="${item.name}">
      <input type="radio" name="color" value="${item.id}">
      <span style="background:${item.hex}"></span>
      ${item.name}
    </label>
  `).join("") || "<p>Renk tanımlı değil.</p>";

  document.querySelector("#stl-infill").innerHTML = INFILL_OPTIONS.map((item) => `
    <label class="stl-option">
      <input type="radio" name="infill" value="${item.value}" ${item.value === quote.infill ? "checked" : ""}>
      <span class="stl-option__body">
        <strong>${item.label}</strong>
        <small>${item.note}</small>
      </span>
    </label>
  `).join("");
}

document.querySelector("#stl-materials").addEventListener("change", (event) => {
  quote.materialId = Number(event.target.value);
  updateNav();
  refreshPrice();
});

document.querySelector("#stl-infill").addEventListener("change", (event) => {
  quote.infill = Number(event.target.value);
  refreshPrice();
});

quantityInput.addEventListener("input", () => {
  quote.quantity = Math.max(1, Number(quantityInput.value) || 1);
  refreshPrice();
});

/* ---------- pricing: always the server's answer ---------- */

const distinctColorCount = () =>
  new Set(quote.parts.map((part) => part.colorId).filter(Boolean)).size || 1;

async function refreshPrice() {
  if (!quote.file || !quote.materialId) return;
  try {
    const price = await fetch("/api/quote-price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        volume_cm3: quote.volumeCm3,
        max_dim_mm: quote.maxDim,
        material_id: quote.materialId,
        infill: quote.infill,
        quantity: quote.quantity,
        color_count: distinctColorCount()
      })
    }).then((response) => response.json());

    if (price.error) return;
    priceEl.textContent = money(price.total);

    const lines = [
      `${price.material.name} · %${price.infill} dolgu · ${price.used_volume_cm3.toFixed(2)} cm³ kullanılıyor`,
      `hazırlık ${money(price.setup_fee)} + ${price.quantity} x ${money(price.unit_price)}`
    ];
    if (price.color_fee > 0) {
      lines.push(
        `${price.color_count} renk · her ek renk filament değişimi ve purge israfı demek: ` +
        `+${money(price.color_fee)} (${price.color_count - 1} x ${money(price.color_change_fee)} x ${price.quantity} adet)`
      );
    }
    breakdownEl.textContent = lines.join(" · ");
  } catch {
    /* keep the last known price */
  }
}

/* ---------- per-part STL export ----------
   The workshop needs one printable file per coloured piece: drop them into the
   slicer, assign a filament to each, done. No special software needed. */

function toBinaryStl(geometry) {
  const position = geometry.attributes.position;
  const triangles = Math.floor(position.count / 3);
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let offset = 84;

  for (let t = 0; t < triangles; t += 1) {
    a.fromBufferAttribute(position, t * 3);
    b.fromBufferAttribute(position, t * 3 + 1);
    c.fromBufferAttribute(position, t * 3 + 2);
    normal.copy(ab.subVectors(b, a).cross(ac.subVectors(c, a))).normalize();

    view.setFloat32(offset, normal.x, true);
    view.setFloat32(offset + 4, normal.y, true);
    view.setFloat32(offset + 8, normal.z, true);
    offset += 12;

    [a, b, c].forEach((vertex) => {
      view.setFloat32(offset, vertex.x, true);
      view.setFloat32(offset + 4, vertex.y, true);
      view.setFloat32(offset + 8, vertex.z, true);
      offset += 12;
    });

    view.setUint16(offset, 0, true);
    offset += 2;
  }

  return buffer;
}

const slug = (value) => (value || "")
  .toLowerCase()
  .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
  .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

/* ---------- submit ---------- */

quoteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!quote.file || !quote.materialId) {
    formMessage.textContent = "Önce dosya ve malzeme seçin.";
    return;
  }

  const data = new FormData(quoteForm);
  data.set("model", quote.file, quote.file.name);
  data.set("width", quote.width.toFixed(2));
  data.set("height", quote.height.toFixed(2));
  data.set("depth", quote.depth.toFixed(2));
  data.set("volume_cm3", String(quote.volumeCm3));
  data.set("max_dim_mm", String(quote.maxDim));
  data.set("material_id", String(quote.materialId));
  data.set("infill", String(quote.infill));
  data.set("quantity", String(quote.quantity));
  data.set("painted", quote.painted ? "1" : "0");
  data.set("parts", JSON.stringify(quote.parts.map((part) => ({
    name: part.name,
    volume_cm3: part.volumeCm3,
    color_id: part.colorId
  }))));

  // One printable STL per part, in the same order as `parts`. The viewer works in
  // three's Y-up space, but slicers expect Z-up like the original file — so undo
  // that rotation on the way out, or every exported part lands on its side.
  const yUpToZUp = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const partFiles = quote.parts.map((part) => {
    const geometry = part.mesh.geometry.clone().applyMatrix4(yUpToZUp);
    const stl = toBinaryStl(geometry);
    const label = slug(part.colorName) || "renk-yok";
    return new File([stl], `parca-${part.index + 1}-${label}.stl`, { type: "model/stl" });
  });

  const submit = document.querySelector("#stl-submit");
  submit.disabled = true;
  formMessage.textContent = "Gönderiliyor...";

  try {
    /* Dosyalar sunucudan geçemez: bir model 10-100 MB, sunucusuz platformun
       istek sınırı ise ~4.5 MB. Sunucudan imzalı bir adres alıp dosyayı
       doğrudan depoya yüklüyoruz; sunucuya yalnızca anahtarı gidiyor.
       Depolama yapılandırılmamışsa (yerel geliştirme) eski yol kullanılır. */
    const uploaded = await uploadDirect([quote.file, ...partFiles]);
    if (uploaded) {
      data.delete("model");
      data.set("model_path", uploaded[0]);
      data.set("model_name", quote.file.name);
      data.set("part_paths", JSON.stringify(uploaded.slice(1)));
    } else {
      data.set("model", quote.file, quote.file.name);
      partFiles.forEach((file) => data.append("part_files", file));
    }

    const response = await fetch("/api/quotes", { method: "POST", body: data });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Teklif gönderilemedi.");
    formMessage.textContent = `Teklifiniz alındı. Teklif no: ${payload.quote_number} - toplam ${money(payload.total)}`;
    quoteForm.reset();
  } catch (error) {
    formMessage.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

/* Her dosya için imzalı adres alıp doğrudan depoya yükler ve anahtarları
   sırayla döndürür. Depolama kapalıysa null döner — çağıran eski yola düşer. */
async function uploadDirect(files) {
  const keys = [];
  for (const [index, file] of files.entries()) {
    const signRes = await fetch("/api/uploads/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "model", filename: file.name })
    });
    if (signRes.status === 503) return null;          // depolama yapılandırılmamış
    const signed = await signRes.json();
    if (!signRes.ok) throw new Error(signed.error || "Yükleme adresi alınamadı.");

    formMessage.textContent = `Dosyalar yükleniyor… (${index + 1}/${files.length})`;
    const put = await fetch(signed.signedUrl, { method: "PUT", body: file });
    if (!put.ok) throw new Error("Dosya yüklenemedi, bağlantınızı kontrol edin.");
    keys.push(signed.path);
  }
  formMessage.textContent = "Gönderiliyor...";
  return keys;
}

loadOptions();
showStep(1);
