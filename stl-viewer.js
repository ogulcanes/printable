import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.167.1/build/three.module.js";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.167.1/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "https://cdn.jsdelivr.net/npm/three@0.167.1/examples/jsm/loaders/STLLoader.js";

const input = document.querySelector("#stl-file");
const viewer = document.querySelector("#stl-viewer");
const dimensionsEl = document.querySelector("#stl-dimensions");
const volumeEl = document.querySelector("#stl-volume");
const priceEl = document.querySelector("#stl-price");

let scene;
let camera;
let renderer;
let controls;
let mesh;
let animationId;

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

  const grid = new THREE.GridHelper(220, 22, 0xffb199, 0xf0d8cc);
  grid.position.y = -2;
  scene.add(grid);

  window.addEventListener("resize", resizeViewer);
  animate();
}

function resizeViewer() {
  if (!renderer || !viewer) return;
  camera.aspect = viewer.clientWidth / viewer.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewer.clientWidth, viewer.clientHeight);
}

function animate() {
  animationId = requestAnimationFrame(animate);
  if (mesh) mesh.rotation.z += 0.002;
  controls?.update();
  renderer?.render(scene, camera);
}

function loadStl(file) {
  initViewer();
  const reader = new FileReader();
  reader.onload = () => {
    const geometry = new STLLoader().parse(reader.result);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    if (mesh) scene.remove(mesh);
    const material = new THREE.MeshStandardMaterial({
      color: 0xff6542,
      roughness: 0.55,
      metalness: 0.08
    });
    mesh = new THREE.Mesh(geometry, material);

    const box = geometry.boundingBox;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    mesh.geometry.translate(-center.x, -center.y, -center.z);
    scene.add(mesh);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    camera.position.set(maxDim * 1.25, maxDim * 1.1, maxDim * 1.45);
    controls.target.set(0, 0, 0);
    controls.update();

    const volumeMm3 = calculateVolume(geometry);
    const volumeCm3 = Math.max(0, volumeMm3 / 1000);
    const price = estimatePrice(volumeCm3, maxDim);

    dimensionsEl.textContent = `${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} mm`;
    volumeEl.textContent = `${volumeCm3.toFixed(2)} cm3`;
    priceEl.textContent = `${price.toFixed(2)} TL`;
  };
  reader.readAsArrayBuffer(file);
}

function calculateVolume(geometry) {
  const position = geometry.attributes.position;
  let volume = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    volume += signedTriangleVolume(a, b, c);
  }

  return Math.abs(volume);
}

function signedTriangleVolume(a, b, c) {
  return a.dot(b.cross(c)) / 6;
}

function estimatePrice(volumeCm3, maxDimMm) {
  const setupFee = 120;
  const materialFee = volumeCm3 * 8.5;
  const sizeFee = (maxDimMm / 10) * 2.5;
  return Math.max(150, setupFee + materialFee + sizeFee);
}

input?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".stl")) {
    alert("Lütfen .stl uzantılı bir dosya seçin.");
    input.value = "";
    return;
  }
  loadStl(file);
});

window.addEventListener("beforeunload", () => {
  if (animationId) cancelAnimationFrame(animationId);
});
