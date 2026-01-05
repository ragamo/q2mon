import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Estado del renderer
let scene, camera, renderer, controls;
let playerMeshes = new Map();
let gridHelper, axesHelper;

// Función para generar color único por ID de jugador
function getPlayerColor(playerId) {
  const colors = [
    0x4a9eff, // Azul
    0x4ade80, // Verde
    0xf87171, // Rojo
    0xfbbf24, // Amarillo
    0xa78bfa, // Púrpura
    0xfb7185, // Rosa
    0x34d399, // Verde esmeralda
    0x60a5fa, // Azul claro
  ];
  return colors[playerId % colors.length];
}

// Inicializar escena 3D
export function initRenderer() {
  // Crear escena
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);

  // Crear cámara
  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    10000
  );
  camera.position.set(500, 500, 500);
  camera.lookAt(0, 0, 0);

  // Crear renderer
  const canvas = document.createElement("canvas");
  canvas.id = "three-canvas";
  document.getElementById("canvas-container").appendChild(canvas);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Controles de órbita
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 50;
  controls.maxDistance = 2000;

  // Luces
  const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(500, 500, 500);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;
  scene.add(directionalLight);

  // Grid helper
  gridHelper = new THREE.GridHelper(2000, 50, 0x444444, 0x222222);
  scene.add(gridHelper);

  // Axes helper
  axesHelper = new THREE.AxesHelper(100);
  scene.add(axesHelper);

  // Manejar resize
  window.addEventListener("resize", onWindowResize);

  // Iniciar loop de renderizado
  animate();

  return {
    updatePlayer,
    removePlayer,
    clearPlayers,
  };
}

// Actualizar posición de jugador
export function updatePlayer(playerId, playerData) {
  const { name, position, angles } = playerData;

  if (!position) return;

  let mesh = playerMeshes.get(playerId);

  if (!mesh) {
    // Crear nueva esfera para el jugador
    const geometry = new THREE.SphereGeometry(20, 16, 16);
    const material = new THREE.MeshStandardMaterial({
      color: getPlayerColor(playerId),
      metalness: 0.3,
      roughness: 0.7,
    });

    mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Agregar etiqueta de nombre (usando sprite)
    const sprite = createNameSprite(name || `Player ${playerId}`);
    mesh.add(sprite);

    scene.add(mesh);
    playerMeshes.set(playerId, mesh);
  }

  // Actualizar posición
  mesh.position.set(position.x, position.y, position.z);

  // Actualizar rotación si hay ángulos
  if (angles) {
    mesh.rotation.set(
      THREE.MathUtils.degToRad(angles.pitch || 0),
      THREE.MathUtils.degToRad(angles.yaw || 0),
      THREE.MathUtils.degToRad(angles.roll || 0)
    );
  }

  // Actualizar nombre si cambió
  if (name && mesh.children.length > 0) {
    const sprite = mesh.children[0];
    if (sprite.userData.name !== name) {
      mesh.remove(sprite);
      const newSprite = createNameSprite(name);
      mesh.add(newSprite);
    }
  }
}

// Remover jugador
export function removePlayer(playerId) {
  const mesh = playerMeshes.get(playerId);
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    if (mesh.children.length > 0) {
      mesh.children.forEach((child) => {
        if (child.material) child.material.dispose();
      });
    }
    playerMeshes.delete(playerId);
  }
}

// Limpiar todos los jugadores
export function clearPlayers() {
  playerMeshes.forEach((mesh, playerId) => {
    removePlayer(playerId);
  });
}

// Crear sprite con nombre del jugador
function createNameSprite(name) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.width = 256;
  canvas.height = 64;

  // Fondo semi-transparente
  context.fillStyle = "rgba(0, 0, 0, 0.7)";
  context.fillRect(0, 0, canvas.width, canvas.height);

  // Texto
  context.fillStyle = "#ffffff";
  context.font = "bold 24px Arial";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMaterial = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
  });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.scale.set(100, 25, 1);
  sprite.position.set(0, 40, 0);
  sprite.userData.name = name;

  return sprite;
}

// Manejar resize de ventana
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Loop de animación
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
