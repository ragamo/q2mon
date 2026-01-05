import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Q2Client } from "./libs/q2client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7000;

// Configuración desde variables de entorno
const SERVER_IP = process.env.Q2_SERVER || "68.183.147.157";
const SERVER_PORT = parseInt(process.env.Q2_PORT) || 27911;
const PASSIVE_MODE = process.env.PASSIVE === "1";
const DEBUG_MODE = process.env.DEBUG === "1";

// Almacenar clientes SSE conectados
const sseClients = new Set();

// Crear instancia del cliente Q2
const client = new Q2Client({
  serverIp: SERVER_IP,
  serverPort: SERVER_PORT,
  passiveMode: PASSIVE_MODE,
  monitorMode: false,
  debug: DEBUG_MODE,
  playerName: "Spectre",
  monitorInterval: 5000,
});

// Middleware para CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

// Endpoint SSE para eventos en tiempo real
app.get("/api/events", (req, res) => {
  // Configurar headers para SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Deshabilitar buffering en nginx

  // Enviar mensaje inicial de conexión
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  // Agregar cliente a la lista
  sseClients.add(res);

  // Limpiar cuando el cliente se desconecta
  req.on("close", () => {
    sseClients.delete(res);
    res.end();
  });
});

// Función helper para enviar eventos a todos los clientes SSE
function broadcastEvent(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => {
    try {
      client.write(message);
    } catch (error) {
      // Cliente desconectado, remover de la lista
      sseClients.delete(client);
    }
  });
}

// Escuchar eventos del Q2Client
client.on("player_update", (event) => {
  broadcastEvent({
    type: "player_update",
    data: event.data,
  });
});

client.on("server_info", (event) => {
  broadcastEvent({
    type: "server_info",
    data: event.data,
  });
});

client.on("connection", (event) => {
  broadcastEvent({
    type: "connection",
    data: event.data,
  });
});

// En producción, servir archivos estáticos del frontend
if (process.env.NODE_ENV === "production") {
  const frontendDist = join(__dirname, "frontend", "dist");
  app.use(express.static(frontendDist));

  app.get("*", (req, res) => {
    res.sendFile(join(frontendDist, "index.html"));
  });
}

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor Express corriendo en http://localhost:${PORT}`);
  console.log(`📡 Conectando a servidor Q2: ${SERVER_IP}:${SERVER_PORT}`);

  // Conectar el cliente Q2
  client.connect();
});

// Manejo de señales para limpieza
process.on("SIGINT", () => {
  console.log("\n🛑 Cerrando servidor...");
  client.disconnect();
  sseClients.forEach((client) => {
    try {
      client.end();
    } catch (error) {
      // Ignorar errores al cerrar
    }
  });
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Cerrando servidor...");
  client.disconnect();
  sseClients.forEach((client) => {
    try {
      client.end();
    } catch (error) {
      // Ignorar errores al cerrar
    }
  });
  process.exit(0);
});
