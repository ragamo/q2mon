/**
 * Ejemplo de uso del módulo Q2Client
 *
 * Este archivo demuestra cómo utilizar el cliente de Quake 2
 * para monitorear servidores y recibir eventos.
 */

import { Q2Client, PRINT_LEVELS } from "./libs/q2client.js";

// Configuración desde variables de entorno
const SERVER_IP = process.env.Q2_SERVER || "68.183.147.157";
const SERVER_PORT = parseInt(process.env.Q2_PORT) || 27911;
const PASSIVE_MODE = process.env.PASSIVE === "1";
const MONITOR_MODE = process.env.MONITOR === "1";
const DEBUG_MODE = process.env.DEBUG === "1";

// Crear instancia del cliente
const client = new Q2Client({
  serverIp: SERVER_IP,
  serverPort: SERVER_PORT,
  passiveMode: PASSIVE_MODE,
  monitorMode: MONITOR_MODE,
  debug: DEBUG_MODE,
  playerName: "Spectre",
  monitorInterval: 5000,
});

// Formato de timestamp corto
function getShortTimestamp() {
  return new Date().toISOString().split("T")[1].slice(0, 12);
}

// =============================================================================
// EVENT HANDLERS
// =============================================================================

// Mensajes de consola del servidor
client.on("console_message", (event) => {
  const { level, text } = event.data;
  const prefix = level === "CHAT" ? "💬" : "🖥️";
  console.log(`${prefix} [${getShortTimestamp()}] [${level}] ${text}`);
});

// Actualizaciones de jugadores (posición, estado)
client.on("player_update", (event) => {
  const p = event.data;
  const pos = p.position;
  const posStr = pos
    ? `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`
    : "N/A";

  if (p.isLocalPlayer) {
    return;
    // Estado del jugador local (nosotros)
    console.log(
      `👤 [${getShortTimestamp()}] LOCAL: pos=${posStr} weapon=${p.weapon}`
    );
  }

  // Otros jugadores
  /* console.log(
    `👥 [${getShortTimestamp()}] ${p.name}: pos=${posStr} alive=${p.alive}`
  ); */
});

// Actualizaciones de entidades (items, proyectiles, etc)
client.on("entity_update", (event) => {
  // console.log(event);
  /* const e = event.data;
  const pos = e.position;
  const posStr = pos
    ? `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`
    : "N/A";

  // Solo mostrar si no está siendo removida
  if (!e.removed) {
    console.log(
      `📦 [${getShortTimestamp()}] Entity #${e.id} [${
        e.entityType
      }]: pos=${posStr} model=${e.modelIndex}`
    );
  } */
});

// Información del servidor
client.on("server_info", (event) => {
  const info = event.data;

  switch (info.event) {
    case "connected":
      console.log(`\n🎮 Conectado al servidor`);
      console.log(`   Mapa: ${info.map}`);
      console.log(`   Mod: ${info.gameDir}`);
      console.log(`   Protocolo: ${info.protocol}\n`);
      break;

    case "status":
      console.log(`\n🎮 ${info.hostname}`);
      console.log(`   Mapa: ${info.map}`);
      console.log(`   Jugadores: ${info.players}/${info.maxPlayers}`);
      if (info.playerList && info.playerList.length > 0) {
        console.log(`   Lista:`);
        info.playerList.forEach((p) => {
          console.log(
            `     - ${p.name} (score: ${p.score}, ping: ${p.ping}ms)`
          );
        });
      }
      console.log("");
      break;

    case "map_change":
      console.log(
        `\n🗺️ [${getShortTimestamp()}] Cambio de mapa: ${info.previousMap} → ${
          info.map
        }\n`
      );
      break;

    case "player_join":
      console.log(
        `👤 [${getShortTimestamp()}] ${info.name} se conectó (ping: ${
          info.ping
        }ms)`
      );
      break;

    case "player_leave":
      console.log(`👋 [${getShortTimestamp()}] ${info.name} se desconectó`);
      break;

    case "player_info":
      console.log(
        `📋 [${getShortTimestamp()}] Jugador #${info.playerId}: ${info.name}`
      );
      break;
  }
});

// Estado de conexión
client.on("connection", (event) => {
  const conn = event.data;

  switch (conn.status) {
    case "connecting":
      console.log(
        `📡 [${getShortTimestamp()}] Conectando a ${SERVER_IP}:${SERVER_PORT}...`
      );
      break;

    case "connected":
      console.log(`✅ [${getShortTimestamp()}] ¡Conexión establecida!`);
      break;

    case "spawned":
      if (conn.passive) {
        console.log(
          `👁️ [${getShortTimestamp()}] Modo pasivo - Escuchando sin entrar al juego`
        );
      } else {
        console.log(
          `🎮 [${getShortTimestamp()}] ¡En el juego! Escuchando eventos...`
        );
      }
      break;

    case "monitoring":
      console.log(`📊 [${getShortTimestamp()}] Modo monitor iniciado`);
      break;

    case "reconnecting":
      console.log(
        `🔄 [${getShortTimestamp()}] Reconectando... (intento ${
          conn.attempt || "?"
        }/${conn.maxAttempts || "?"})`
      );
      break;

    case "disconnected":
      console.log(
        `❌ [${getShortTimestamp()}] Desconectado: ${
          conn.reason || "desconocido"
        }`
      );
      break;

    case "error":
      console.log(`❌ [${getShortTimestamp()}] Error: ${conn.reason}`);
      break;
  }
});

// Debug: todos los mensajes raw
if (DEBUG_MODE) {
  client.on("raw_message", (event) => {
    console.log(
      `🔧 RAW [${event.type}]:`,
      JSON.stringify(event.data).substring(0, 100)
    );
  });
}

// =============================================================================
// INICIO
// =============================================================================

console.log(`\n${"═".repeat(60)}`);
console.log(`   QUAKE 2 CLIENT MODULE - Ejemplo de uso`);
console.log(`${"═".repeat(60)}`);
console.log(`🎯 Servidor: ${SERVER_IP}:${SERVER_PORT}`);
console.log(
  `🔧 Modo: ${MONITOR_MODE ? "MONITOR" : PASSIVE_MODE ? "PASIVO" : "CLIENTE"}`
);
console.log(`🐛 Debug: ${DEBUG_MODE ? "ON" : "OFF"}`);
console.log(`⌨️  Ctrl+C para salir`);
console.log(`${"─".repeat(60)}\n`);

// Conectar
client.connect();

// Manejo de señales
process.on("SIGINT", () => {
  console.log(`\n\n${"─".repeat(60)}`);
  console.log(`🛑 Cerrando cliente...`);
  client.disconnect();
  console.log(`👋 ¡Hasta luego!\n`);
  process.exit(0);
});

// Exportar cliente para uso programático
export { client };
