import { initRenderer } from "./renderer.js";

// Estado de la aplicación
const state = {
  connected: false,
  serverInfo: null,
  players: new Map(),
};

// Elementos del DOM
const statusEl = document.getElementById("status");
const serverInfoEl = document.getElementById("server-info");
const playersListEl = document.getElementById("players-list");

// Inicializar renderer 3D
const renderer = initRenderer();

// Función para actualizar el estado de conexión
function updateConnectionStatus(status, text) {
  statusEl.className = `status ${status}`;
  statusEl.textContent = text;
  state.connected = status === "connected";
}

// Función para actualizar información del servidor
function updateServerInfo(info) {
  if (info) {
    state.serverInfo = info;
    if (info.map) {
      serverInfoEl.textContent = `Mapa: ${info.map}`;
    }
  }
}

// Función para actualizar lista de jugadores en el DOM
function updatePlayersList() {
  playersListEl.innerHTML = "";

  if (state.players.size === 0) {
    playersListEl.innerHTML =
      '<div style="color: #9ca3af; font-size: 12px;">No hay jugadores</div>';
    return;
  }

  state.players.forEach((player, id) => {
    const item = document.createElement("div");
    item.className = "player-item";

    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = player.name || `Jugador ${id}`;

    const pos = document.createElement("div");
    pos.className = "player-pos";
    if (player.position) {
      pos.textContent = `(${player.position.x.toFixed(
        1
      )}, ${player.position.y.toFixed(1)}, ${player.position.z.toFixed(1)})`;
    } else {
      pos.textContent = "Sin posición";
    }

    item.appendChild(name);
    item.appendChild(pos);
    playersListEl.appendChild(item);
  });
}

// Conectar a Server-Sent Events
function connectSSE() {
  const eventSource = new EventSource("/api/events");

  eventSource.onopen = () => {
    updateConnectionStatus("connected", "Conectado");
    console.log("✅ Conectado al servidor SSE");
  };

  eventSource.onerror = () => {
    updateConnectionStatus("disconnected", "Desconectado");
    console.error("❌ Error en conexión SSE");

    // Intentar reconectar después de 3 segundos
    setTimeout(() => {
      if (!state.connected) {
        connectSSE();
      }
    }, 3000);
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case "connected":
          updateConnectionStatus("connecting", "Conectando...");
          break;

        case "player_update":
          handlePlayerUpdate(data.data);
          break;

        case "server_info":
          handleServerInfo(data.data);
          break;

        case "connection":
          handleConnection(data.data);
          break;

        default:
          console.log("Evento desconocido:", data.type);
      }
    } catch (error) {
      console.error("Error parseando evento SSE:", error);
    }
  };

  return eventSource;
}

// Manejar actualización de jugador
function handlePlayerUpdate(playerData) {
  const { id, name, position, alive, angles } = playerData;

  // Actualizar estado
  state.players.set(id, {
    id,
    name,
    position,
    alive,
    angles,
  });

  // Actualizar renderer 3D
  if (position && alive !== false) {
    renderer.updatePlayer(id, {
      name,
      position,
      angles,
    });
  } else {
    // Remover jugador si no está vivo
    renderer.removePlayer(id);
    state.players.delete(id);
  }

  // Actualizar lista en DOM
  updatePlayersList();
}

// Manejar información del servidor
function handleServerInfo(serverData) {
  updateServerInfo(serverData);

  if (serverData.event === "connected") {
    updateConnectionStatus("connected", "Conectado");
  }
}

// Manejar cambios de conexión
function handleConnection(connData) {
  switch (connData.status) {
    case "connecting":
      updateConnectionStatus("connecting", "Conectando...");
      break;
    case "connected":
      updateConnectionStatus("connected", "Conectado");
      break;
    case "spawned":
      updateConnectionStatus("connected", "En juego");
      break;
    case "disconnected":
      updateConnectionStatus("disconnected", "Desconectado");
      // Limpiar jugadores
      state.players.clear();
      renderer.clearPlayers();
      updatePlayersList();
      break;
    case "reconnecting":
      updateConnectionStatus("connecting", "Reconectando...");
      break;
  }
}

// Iniciar conexión SSE
let eventSource = connectSSE();

// Limpiar al cerrar
window.addEventListener("beforeunload", () => {
  if (eventSource) {
    eventSource.close();
  }
});
