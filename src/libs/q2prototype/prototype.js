import dgram from "dgram";
import fs from "fs";
import zlib from "zlib";

// Configuración del servidor
const SERVER_IP = process.env.Q2_SERVER || "68.183.147.157"; // "64.176.7.175";
const SERVER_PORT = parseInt(process.env.Q2_PORT) || 27911; // 27910;

// Archivo de log para mensajes de consola
const CONSOLE_LOG_FILE = "console_messages.log";

// Modo debug - muestra detalles técnicos de los paquetes
const DEBUG_MODE = process.env.DEBUG === "1" || false;

// Modo espectador pasivo - no enviar "begin", quedarse en estado de carga
// Útil cuando el servidor rechaza conexiones de clientes
// En modo pasivo, el cliente recibe configstrings y print messages sin entrar al juego
const PASSIVE_MODE = process.env.PASSIVE === "1" || false;

// Modo monitor - solo usa queries OOB (status/info) sin conectarse como cliente
// Útil para servidores con restricciones (clanwar, matchmode, etc.)
const MONITOR_MODE = process.env.MONITOR === "1" || false;

// Intervalo de polling en modo monitor (ms)
const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL) || 5000;

// Versiones de protocolo soportadas (basado en q2pro)
const PROTOCOL = {
  VERSION_OLD: 26,
  VERSION_DEFAULT: 34,
  VERSION_R1Q2: 35,
  VERSION_Q2PRO: 36,
  VERSION_MVD: 37,
  VERSION_AQTION: 38,
};

// Versiones menores del protocolo
const PROTOCOL_MINOR = {
  Q2PRO_CURRENT: 1024,
  AQTION_CURRENT: 3015,
  R1Q2_CURRENT: 1905,
};

// Códigos de servicio (svc) del protocolo de Quake 2
// Basado en q2pro/inc/common/protocol.h
const SVC = {
  BAD: 0,
  MUZZLEFLASH: 1,
  MUZZLEFLASH2: 2,
  TEMP_ENTITY: 3,
  LAYOUT: 4,
  INVENTORY: 5,
  NOP: 6,
  DISCONNECT: 7,
  RECONNECT: 8,
  SOUND: 9,
  PRINT: 10,
  STUFFTEXT: 11,
  SERVERDATA: 12,
  CONFIGSTRING: 13,
  SPAWNBASELINE: 14,
  CENTERPRINT: 15,
  DOWNLOAD: 16,
  PLAYERINFO: 17,
  PACKETENTITIES: 18,
  DELTAPACKETENTITIES: 19,
  FRAME: 20,
  // Extensiones R1Q2/Q2PRO
  ZPACKET: 21,
  ZDOWNLOAD: 22,
  GAMESTATE: 23,
  SETTING: 24,
  CONFIGSTRINGSTREAM: 25,
  BASELINESTREAM: 26,
  // AQtion
  GHUDUPDATE: 29,
  EXTEND: 30,
  USERSTATISTIC: 31,
  CVARSYNC: 32,
};

// Bits de máscara para SVC
const SVCMD_BITS = 5;
const SVCMD_MASK = (1 << SVCMD_BITS) - 1;

// Códigos de comandos del cliente (clc)
const CLC = {
  BAD: 0,
  NOP: 1,
  MOVE: 2,
  USERINFO: 3,
  STRINGCMD: 4,
  SETTING: 5,
  // Q2PRO extended
  MOVE_NODELTA: 10,
  MOVE_BATCHED: 11,
  USERINFO_DELTA: 12,
};

// Niveles de print
const PRINT_LEVELS = {
  0: "LOW",
  1: "MEDIUM",
  2: "HIGH",
  3: "CHAT",
};

// Cliente UDP
const socket = dgram.createSocket("udp4");

// Estado del cliente - Netchan
let isConnected = false;
let clientChallengeId = Math.floor(Math.random() * 0x7fffffff);
let clientQport = Math.floor(Math.random() * 255); // Q2PRO usa qport de 8 bits
let lastPacketTime = Date.now();
let heartbeatInterval = null;

// Netchan state - basado en q2pro netchan
let incomingSequence = 0; // Último número de secuencia recibido del servidor
let incomingAcknowledged = 0; // Último ack que el servidor envió
let incomingReliableAcknowledged = 0; // Último bit reliable que el servidor confirmó
let incomingReliableSequence = 0; // Bit de reliable actual recibido

let outgoingSequence = 1; // Próximo número de secuencia a enviar
let reliableSequence = 0; // Bit de reliable actual (0 o 1)
let lastReliableSequence = 0; // Último reliable enviado que espera confirmación

let hasServerData = false;
let hasSentNew = false;
let hasSentBegin = false;
let precacheReceived = false;
let keepAliveInterval = null;
let configStrings = {};
let serverCount = 0;
let spawnCount = 0;
let lastFrameNum = -1;
let connectionState = "disconnected"; // disconnected, challenging, connecting, connected, spawned
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let playerNames = {}; // Cache de nombres de jugadores
let serverProtocol = PROTOCOL.VERSION_DEFAULT; // Protocolo detectado del servidor
let serverProtocolMinor = 0; // Versión menor del protocolo
let netchanType = 1; // 0 = old, 1 = new (Q2PRO)
let currentMapName = ""; // Mapa actual para detectar cambios

/**
 * Obtiene timestamp formateado
 */
function getTimestamp() {
  return new Date().toISOString();
}

function getShortTimestamp() {
  return new Date().toISOString().split("T")[1].slice(0, 12);
}

/**
 * Crea un paquete OOB (Out of Band)
 * Los paquetes OOB comienzan con -1 (0xFFFFFFFF)
 */
function createOOBPacket(command) {
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from(command + "\n", "ascii"),
  ]);
}

/**
 * Crea un paquete de conexión
 * Format: connect <protocol> <qport> <challenge> "<userinfo>" [extra params]
 * Para Q2PRO/AQtion: connect <protocol> <qport> <challenge> "<userinfo>" <maxmsglen> <netchan> <zlib> <minorversion>
 */
function createConnectPacket(challenge = null, protocol = null) {
  protocol = protocol || serverProtocol || PROTOCOL.VERSION_DEFAULT;
  const challengeId = challenge || clientChallengeId;

  // Userinfo que imita un cliente Q2PRO válido
  const userinfo = [
    "\\name\\Gojira",
    "\\skin\\male/grunt",
    "\\rate\\25000",
    "\\msg\\1",
    "\\hand\\2",
    "\\fov\\90",
    "\\spectator\\1", // Conectar como espectador
  ].join("");

  let connectCommand;

  // Formato según protocolo
  if (protocol === PROTOCOL.VERSION_Q2PRO) {
    // Q2PRO: connect <protocol> <qport> <challenge> "<userinfo>" <maxmsglen> <netchan> <zlib> <minorversion>
    const maxmsglen = 1390;
    const useZlib = 1; // Soportamos zlib
    connectCommand = `connect ${protocol} ${clientQport} ${challengeId} "${userinfo}" ${maxmsglen} ${netchanType} ${useZlib} ${PROTOCOL_MINOR.Q2PRO_CURRENT}`;
  } else if (protocol === PROTOCOL.VERSION_AQTION) {
    // AQtion: igual que Q2PRO
    const maxmsglen = 1390;
    const useZlib = 1;
    connectCommand = `connect ${protocol} ${clientQport} ${challengeId} "${userinfo}" ${maxmsglen} ${netchanType} ${useZlib} ${PROTOCOL_MINOR.AQTION_CURRENT}`;
  } else if (protocol === PROTOCOL.VERSION_R1Q2) {
    // R1Q2: connect <protocol> <qport> <challenge> "<userinfo>" <maxmsglen> <minorversion>
    const maxmsglen = 1390;
    connectCommand = `connect ${protocol} ${clientQport} ${challengeId} "${userinfo}" ${maxmsglen} ${PROTOCOL_MINOR.R1Q2_CURRENT}`;
  } else {
    // Protocolo vanilla 34
    connectCommand = `connect ${protocol} ${clientQport} ${challengeId} "${userinfo}"`;
  }

  return createOOBPacket(connectCommand);
}

/**
 * Crea un paquete de getChallenge
 */
function createGetChallengePacket() {
  return createOOBPacket("getchallenge");
}

/**
 * Lee un string terminado en 0x00 desde un buffer
 */
function readCString(buffer, startIndex) {
  let end = startIndex;
  while (end < buffer.length && buffer[end] !== 0) {
    end++;
  }
  return {
    text: buffer.slice(startIndex, end).toString("latin1"),
    nextIndex: end + 1,
  };
}

function readInt16(buffer, idx) {
  if (idx + 2 > buffer.length) return { value: 0, nextIndex: buffer.length };
  return { value: buffer.readInt16LE(idx), nextIndex: idx + 2 };
}

function readUInt16(buffer, idx) {
  if (idx + 2 > buffer.length) return { value: 0, nextIndex: buffer.length };
  return { value: buffer.readUInt16LE(idx), nextIndex: idx + 2 };
}

function readInt32(buffer, idx) {
  if (idx + 4 > buffer.length) return { value: 0, nextIndex: buffer.length };
  return { value: buffer.readInt32LE(idx), nextIndex: idx + 4 };
}

/**
 * Limpia caracteres de Quake (colores, etc)
 * Los caracteres 0x80-0xFF son versiones "coloreadas" de 0x00-0x7F
 */
function cleanQuakeString(str) {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0x80) c -= 0x80;
    if (c >= 0x20 && c < 0x7f) {
      result += String.fromCharCode(c);
    } else if (c === 0x0a || c === 0x0d) {
      result += "\n";
    }
  }
  return result.trim();
}

/**
 * Parsea paquetes OOB del servidor
 */
function parseOOBPacket(buffer) {
  try {
    const isOOB =
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xff &&
      buffer[2] === 0xff &&
      buffer[3] === 0xff;

    if (!isOOB) {
      return parseSequencedPacket(buffer);
    }

    const content = buffer.slice(4).toString("latin1");
    const lines = content.split("\n");
    const firstLine = lines[0].trim();

    // Challenge response: "challenge <number> [p=<protocols>]"
    if (firstLine.startsWith("challenge")) {
      const parts = firstLine.split(/\s+/);
      const challengeId = parseInt(parts[1]);

      // Detectar protocolos soportados por el servidor
      let supportedProtocols = [];
      for (let i = 2; i < parts.length; i++) {
        if (parts[i].startsWith("p=")) {
          supportedProtocols = parts[i]
            .substring(2)
            .split(",")
            .map((p) => parseInt(p));
        }
      }

      return {
        type: "challenge",
        challengeId,
        supportedProtocols,
      };
    } else if (firstLine.startsWith("print")) {
      const message = content.substring(6).trim();
      return {
        type: "print",
        message: cleanQuakeString(message),
      };
    } else if (firstLine.startsWith("client_connect")) {
      // Parsear parámetros adicionales del connect
      const params = {};
      const parts = firstLine.split(/\s+/);
      for (let i = 1; i < parts.length; i++) {
        const [key, value] = parts[i].split("=");
        if (key && value) {
          params[key] = value;
        }
      }
      return {
        type: "client_connect",
        params,
        message: content,
      };
    } else if (firstLine.startsWith("disconnect")) {
      return {
        type: "disconnect",
        reason: content.substring(10).trim(),
      };
    } else if (firstLine === "ack") {
      return { type: "ack" };
    } else if (firstLine.startsWith("statusResponse")) {
      return {
        type: "statusResponse",
        content,
      };
    } else if (firstLine.startsWith("info")) {
      return {
        type: "info",
        content,
      };
    }

    return {
      type: "unknown_oob",
      raw: content,
    };
  } catch (error) {
    console.error(`❌ Error al parsear paquete: ${error.message}`);
    return null;
  }
}

// Bits de netchan
const REL_BIT = 0x80000000; // Bit 31 - mensaje reliable
const FRG_BIT = 0x40000000; // Bit 30 - mensaje fragmentado (solo netchan new)
const OLD_MASK = REL_BIT - 1;
const NEW_MASK = FRG_BIT - 1;

// Estado de fragmentación
let fragmentSequence = 0;
let fragmentBuffer = Buffer.alloc(0);

/**
 * Parsea paquetes secuenciados (netchan)
 * Basado en Netchan_Process de q2pro
 *
 * Header: 4 bytes sequence + 4 bytes ack
 * Si es cliente recibiendo del servidor, no hay qport en el header
 * Si es fragmentado (FRG_BIT): 2 bytes fragment_offset después del header
 */
function parseSequencedPacket(buffer) {
  if (buffer.length < 8) {
    return { type: "sequenced", error: "Paquete demasiado corto" };
  }

  const sequenceRaw = buffer.readUInt32LE(0);
  const ackRaw = buffer.readUInt32LE(4);

  // Extraer bits y secuencia según tipo de netchan
  const reliable = (sequenceRaw & REL_BIT) !== 0;
  const fragmented = (sequenceRaw & FRG_BIT) !== 0;
  const reliableAck = (ackRaw & REL_BIT) !== 0;

  // Usar la máscara correcta según si es fragmentado o no
  // En netchan_new, usamos NEW_MASK
  const sequence = sequenceRaw & NEW_MASK;
  const ack = ackRaw & NEW_MASK;

  let dataOffset = 8;
  let fragmentOffset = 0;
  let moreFragments = false;

  // Si es fragmentado, leer el header de fragmentación
  if (fragmented && buffer.length >= 10) {
    const fragHeader = buffer.readUInt16LE(8);
    moreFragments = (fragHeader & 0x8000) !== 0;
    fragmentOffset = fragHeader & 0x7fff;
    dataOffset = 10;
  }

  const data = buffer.length > dataOffset ? buffer.slice(dataOffset) : null;

  return {
    type: "sequenced",
    sequence,
    reliable,
    fragmented,
    fragmentOffset,
    moreFragments,
    ack,
    reliableAck,
    hasData: data && data.length > 0,
    data,
  };
}

/**
 * Descomprime datos zlib
 */
function decompressZlib(data) {
  try {
    return zlib.inflateRawSync(data);
  } catch (e) {
    if (DEBUG_MODE) {
      console.log(`⚠️ Error descomprimiendo zlib: ${e.message}`);
    }
    return null;
  }
}

/**
 * Escanea un buffer buscando stufftexts (svc_stufftext = 11)
 * Útil cuando no podemos parsear comandos complejos como spawnbaseline
 */
function scanForStufftexts(data, startIdx) {
  const messages = [];

  // Buscar el opcode de stufftext (11) seguido de un string válido
  for (let i = startIdx; i < data.length - 2; i++) {
    if (data[i] === SVC.STUFFTEXT) {
      // Intentar leer el string
      const { text, nextIndex } = readCString(data, i + 1);
      if (text && text.length > 0 && text.length < 256) {
        const cleaned = text.trim();
        // Verificar que parece un comando válido
        if (
          cleaned &&
          (cleaned.startsWith("precache") ||
            cleaned.startsWith("skins") ||
            cleaned.startsWith("cmd ") ||
            cleaned.startsWith("reconnect") ||
            cleaned.startsWith("disconnect"))
        ) {
          if (DEBUG_MODE) {
            console.log(`  📋 Encontrado stufftext en pos ${i}: "${cleaned}"`);
          }
          messages.push({ type: "stufftext", text: cleaned });
          i = nextIndex - 1; // Saltar al siguiente posible comando
        }
      }
    }
    // También buscar svc_print (10)
    else if (data[i] === SVC.PRINT && i + 1 < data.length) {
      const level = data[i + 1];
      if (level >= 0 && level <= 3) {
        const { text, nextIndex } = readCString(data, i + 2);
        const cleanText = cleanQuakeString(text);
        if (cleanText && cleanText.length > 0 && cleanText.length < 1024) {
          if (DEBUG_MODE) {
            console.log(
              `  📋 Encontrado print en pos ${i}: "${cleanText.substring(
                0,
                50
              )}"`
            );
          }
          messages.push({ type: "print", level, text: cleanText });
          i = nextIndex - 1;
        }
      }
    }
  }

  return messages;
}

/**
 * Procesa un paquete de datos del servidor
 * Este puede estar comprimido con zlib (wrapped en un pseudo-zpacket sin opcode)
 */
function processServerData(data) {
  // El servidor Q2PRO/AQtion puede enviar datos comprimidos
  // Formato: 2 bytes flags/len, 2 bytes outlen, N bytes compressed data

  if (data.length < 5) {
    return parseGameMessage(data, false);
  }

  // Detectar si es un paquete zlib comprimido
  // En Q2PRO, el primer byte suele ser el opcode, pero si es 0x00 o el patrón
  // sugiere compresión, intentamos descomprimir

  const firstByte = data[0];

  // Si el primer byte es un opcode válido (svc_serverdata = 12, etc.), parsear normalmente
  // svc_serverdata (12) es común como primer comando después de "new"
  if (firstByte >= SVC.NOP && firstByte <= SVC.CVARSYNC) {
    return parseGameMessage(data, false);
  }

  // Intentar interpretar como zpacket wrapper (sin opcode)
  // Algunos servidores Q2PRO envían el contenido directamente comprimido
  if (firstByte === 0 || firstByte & 0x80) {
    // Puede ser datos comprimidos - intentar descomprimir los primeros bytes
    // como si fuera un zpacket
    try {
      // Formato podría ser: inlen (2) + outlen (2) + compressed data
      // O: flags (2) + inlen (2) + outlen (2) + compressed data

      // Primer intento: todo el buffer como datos comprimidos
      const decompressed = zlib.inflateRawSync(data);
      if (decompressed && decompressed.length > 0) {
        if (DEBUG_MODE) {
          console.log(
            `📦 Descomprimido ${data.length} -> ${decompressed.length} bytes`
          );
        }
        return parseGameMessage(decompressed, false);
      }
    } catch (e) {
      // No es zlib puro, intentar con header
    }

    // Segundo intento: con header de tamaños
    if (data.length >= 4) {
      const inlen = data.readUInt16LE(0);
      const outlen = data.readUInt16LE(2);

      if (
        inlen > 0 &&
        inlen < data.length - 4 &&
        outlen > 0 &&
        outlen < 65536
      ) {
        try {
          const compressed = data.slice(4, 4 + inlen);
          const decompressed = zlib.inflateRawSync(compressed);
          if (decompressed && decompressed.length > 0) {
            if (DEBUG_MODE) {
              console.log(
                `📦 Descomprimido (header) ${inlen} -> ${decompressed.length} bytes`
              );
            }
            return parseGameMessage(decompressed, false);
          }
        } catch (e) {
          // No funciona, parsear como normal
        }
      }
    }
  }

  // Fallback: parsear como mensaje normal
  return parseGameMessage(data, false);
}

/**
 * Parsea mensajes del protocolo de juego - enfocado en extraer texto de consola
 * Basado en CL_ParseServerMessage de q2pro
 */
function parseGameMessage(data, isNested = false) {
  const messages = [];
  let idx = 0;

  if (DEBUG_MODE && !isNested && data.length > 0) {
    // Mostrar primeros bytes para debugging
    const preview = Array.from(data.slice(0, Math.min(32, data.length)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    console.log(`📦 Parsing ${data.length} bytes: ${preview}...`);
  }

  while (idx < data.length) {
    const opcode = data[idx];
    idx++;

    if (idx > data.length) break;

    // Manejar opcodes extendidos (Q2PRO/AQtion)
    let cmd = opcode & SVCMD_MASK;
    const extrabits = opcode >> SVCMD_BITS;

    // Debug de opcodes solo para comandos interesantes
    if (
      DEBUG_MODE &&
      (cmd === SVC.PRINT || cmd === SVC.STUFFTEXT || cmd === SVC.SERVERDATA)
    ) {
      console.log(
        `  📋 pos:${idx - 1} opcode:${opcode} cmd:${cmd} (${
          Object.keys(SVC).find((k) => SVC[k] === cmd) || "unknown"
        })`
      );
    }

    // svc_extend para comandos > 31
    if (cmd === SVC.EXTEND && idx < data.length) {
      cmd = data[idx++];
    }

    switch (cmd) {
      case SVC.NOP:
        break;

      case SVC.MUZZLEFLASH:
      case SVC.MUZZLEFLASH2:
        idx += 3;
        break;

      case SVC.TEMP_ENTITY: {
        // Skip temp entity - formato variable complejo
        if (idx >= data.length) return messages;
        const teType = data[idx++];
        // Saltamos según tipo (simplificado)
        switch (teType) {
          case 0:
          case 1:
          case 2:
          case 3:
          case 4:
          case 5:
          case 6:
          case 7:
          case 8:
          case 9:
          case 10:
          case 11:
          case 12:
          case 13:
          case 14:
          case 15:
          case 16:
          case 17:
          case 18:
          case 19:
            idx += 6; // position + dir
            break;
          case 20:
          case 21:
          case 22:
          case 23:
          case 24:
          case 25:
          case 26:
          case 27:
          case 28:
          case 29:
            idx += 12; // start + end
            break;
          default:
            // Tipo no soportado, intentar seguir
            idx += 6;
            break;
        }
        break;
      }

      case SVC.LAYOUT: {
        const { text, nextIndex } = readCString(data, idx);
        idx = nextIndex;
        // Los layouts son el scoreboard
        if (DEBUG_MODE && text.length > 0) {
          messages.push({ type: "layout", text });
        }
        break;
      }

      case SVC.INVENTORY:
        idx += 256 * 2;
        break;

      case SVC.SERVERDATA: {
        // svc_serverdata - datos iniciales del servidor
        // Basado en CL_ParseServerData de q2pro/src/client/parse.c
        if (idx + 9 > data.length) return messages;

        const proto = data.readInt32LE(idx);
        idx += 4;
        serverProtocol = proto;

        const srvCount = data.readInt32LE(idx);
        idx += 4;

        const attractloop = data[idx++];

        const gameDir = readCString(data, idx);
        idx = gameDir.nextIndex;

        // clientNum es SHORT (2 bytes) en todos los protocolos
        const clientNum = readInt16(data, idx);
        idx = clientNum.nextIndex;

        const mapName = readCString(data, idx);
        idx = mapName.nextIndex;

        if (DEBUG_MODE) {
          console.log(
            `🔧 SERVERDATA: proto=${proto} count=${srvCount} attractloop=${attractloop}`
          );
          console.log(
            `   gamedir="${gameDir.text}" clientNum=${clientNum.value} map="${mapName.text}"`
          );
          console.log(
            `   idx después de mapName: ${idx}, data.length: ${data.length}`
          );
        }

        messages.push({
          type: "serverdata",
          protocol: proto,
          serverCount: srvCount,
          attractloop,
          gameDir: gameDir.text,
          clientNum: clientNum.value,
          mapName: cleanQuakeString(mapName.text),
        });

        // Leer datos adicionales según protocolo
        // Estos campos DEBEN leerse para no corromper el parsing del resto del mensaje
        if (proto === PROTOCOL.VERSION_R1Q2) {
          // R1Q2: enhanced (1) + protocolminor (2) + advanced deltas (1) + strafejump hack (1)
          if (idx + 5 <= data.length) {
            const enhanced = data[idx++]; // enhanced (should be 0)
            const minorVersion = data.readUInt16LE(idx);
            idx += 2;
            serverProtocolMinor = minorVersion;
            const advancedDeltas = data[idx++]; // advanced deltas
            const strafejumpHack = data[idx++]; // strafejump hack
            if (DEBUG_MODE) {
              console.log(
                `🔧 R1Q2: minor=${minorVersion} enhanced=${enhanced} advDeltas=${advancedDeltas} strafejump=${strafejumpHack}`
              );
            }
          }
        } else if (proto === PROTOCOL.VERSION_Q2PRO) {
          // Q2PRO: protocolminor (2) + server state (1) + flags (variable)
          if (idx + 3 <= data.length) {
            const minorVersion = data.readUInt16LE(idx);
            idx += 2;
            serverProtocolMinor = minorVersion;
            const serverState = data[idx++]; // server state

            // Flags según versión
            if (serverProtocolMinor >= 1024) {
              // Q2PRO_EXTENDED_LIMITS: word flags
              if (idx + 2 <= data.length) {
                const flags = data.readUInt16LE(idx);
                idx += 2;
                if (DEBUG_MODE) {
                  console.log(
                    `🔧 Q2PRO: minor=${minorVersion} state=${serverState} flags=${flags}`
                  );
                }
              }
            } else {
              // Old format: 3 separate bytes (strafejump, qw, waterjump)
              if (idx + 3 <= data.length) {
                const strafejump = data[idx++];
                const qw = data[idx++];
                const waterjump = data[idx++];
                if (DEBUG_MODE) {
                  console.log(
                    `🔧 Q2PRO: minor=${minorVersion} state=${serverState} strafejump=${strafejump} qw=${qw} waterjump=${waterjump}`
                  );
                }
              }
            }
          }
        } else if (proto === PROTOCOL.VERSION_AQTION) {
          // AQtion (basado en q2pro):
          // protocolminor (2 bytes) + server state (1) + strafejump (1) + qwmode (1) + waterjump (1)
          // Total: 6 bytes adicionales
          if (idx + 6 <= data.length) {
            const minorVersion = data.readUInt16LE(idx);
            idx += 2;
            serverProtocolMinor = minorVersion;
            const serverState = data[idx++]; // server state
            const strafejumpHack = data[idx++]; // strafejump hack
            const qwMode = data[idx++]; // qw mode
            const waterjumpHack = data[idx++]; // waterjump hack

            if (DEBUG_MODE) {
              console.log(
                `🔧 AQtion: minor=${minorVersion} state=${serverState} strafejump=${strafejumpHack} qw=${qwMode} waterjump=${waterjumpHack}`
              );
            }
          } else {
            // Si no hay suficientes bytes, intentar leer lo que hay
            if (DEBUG_MODE) {
              console.log(
                `⚠️ AQtion: No hay suficientes bytes para datos adicionales (idx=${idx}, len=${data.length})`
              );
            }
          }
        }

        if (DEBUG_MODE) {
          console.log(`   idx después de protocol-specific: ${idx}`);
        }
        break;
      }

      case SVC.CONFIGSTRING: {
        if (idx + 2 > data.length) return messages;
        const csIndex = data.readUInt16LE(idx);
        idx += 2;
        const { text, nextIndex } = readCString(data, idx);
        idx = nextIndex;
        const cleanText = cleanQuakeString(text);
        if (cleanText) {
          messages.push({
            type: "configstring",
            index: csIndex,
            text: cleanText,
          });
        }
        break;
      }

      case SVC.SPAWNBASELINE: {
        // Spawnbaseline - formato delta de entidades
        // Es muy complejo y requiere conocer el protocolo exacto
        // Intentamos escanear hacia adelante buscando stufftexts o prints
        if (DEBUG_MODE) {
          console.log(
            `  📋 SPAWNBASELINE detectado - escaneando por stufftexts...`
          );
        }

        // Escanear el resto del buffer buscando patrones conocidos
        const stufftextMessages = scanForStufftexts(data, idx);
        messages.push(...stufftextMessages);

        // No podemos continuar el parsing normal
        return messages;
      }

      case SVC.PRINT: {
        // ¡Este es el comando principal para mensajes de consola!
        if (idx >= data.length) return messages;
        const level = data[idx++];
        const { text, nextIndex } = readCString(data, idx);
        idx = nextIndex;
        const cleanText = cleanQuakeString(text);
        if (cleanText) {
          messages.push({ type: "print", level, text: cleanText });
        }
        break;
      }

      case SVC.CENTERPRINT: {
        const { text, nextIndex } = readCString(data, idx);
        idx = nextIndex;
        const cleanText = cleanQuakeString(text);
        if (cleanText) {
          messages.push({ type: "centerprint", text: cleanText });
        }
        break;
      }

      case SVC.STUFFTEXT: {
        // Comandos que el servidor quiere ejecutar en el cliente
        const { text, nextIndex } = readCString(data, idx);
        idx = nextIndex;
        const stuffCmd = text.trim();
        if (stuffCmd) {
          messages.push({ type: "stufftext", text: stuffCmd });
          // Mostrar siempre stufftext (son importantes para el flujo del cliente)
          console.log(
            `  📝 STUFFTEXT: "${stuffCmd.substring(0, 100)}${
              stuffCmd.length > 100 ? "..." : ""
            }"`
          );
        }
        break;
      }

      case SVC.SOUND: {
        if (idx >= data.length) return messages;
        const flags = data[idx++];
        // Sound index
        if (flags & 0x20) {
          // SND_INDEX16
          idx += 2;
        } else {
          idx++;
        }
        if (flags & 1) idx++; // volume
        if (flags & 2) idx++; // attenuation
        if (flags & 0x10) idx++; // offset
        if (flags & 8) idx += 2; // entity + channel
        if (flags & 4) idx += 6; // position (3 shorts)
        break;
      }

      case SVC.DISCONNECT:
        if (DEBUG_MODE) {
          console.log(`🔌 svc_disconnect recibido en pos ${idx - 1}`);
        }
        messages.push({ type: "server_disconnect" });
        return messages;

      case SVC.RECONNECT:
        if (DEBUG_MODE) {
          console.log(`🔄 svc_reconnect recibido en pos ${idx - 1}`);
        }
        messages.push({ type: "reconnect" });
        return messages;

      case SVC.FRAME: {
        // Frame update - contiene estado del juego
        // Este comando es MUY complejo - svc_frame contiene:
        // - Frame header (número, delta, flags)
        // - areabits
        // - svc_playerinfo (inlined en AQtion/Q2PRO/R1Q2)
        // - svc_packetentities (inlined en AQtion/Q2PRO/R1Q2)
        //
        // Para un cliente pasivo que solo quiere mensajes de consola,
        // NO podemos parsear esto correctamente sin implementar el estado
        // completo del juego. Así que solo leemos el framenum y descartamos
        // el resto del paquete.

        if (idx + 4 > data.length) return messages;

        // Formato depende del protocolo
        if (
          serverProtocol === PROTOCOL.VERSION_Q2PRO ||
          serverProtocol === PROTOCOL.VERSION_AQTION ||
          serverProtocol === PROTOCOL.VERSION_R1Q2
        ) {
          // Protocolo extendido: bits packed
          // bits 0-26: framenum, bits 27-31: delta
          const frameData = data.readUInt32LE(idx);
          idx += 4;
          const frameNum = frameData & 0x07ffffff; // FRAMENUM_MASK (27 bits)
          lastFrameNum = frameNum;

          // suppress count + flags byte
          if (idx < data.length) {
            const suppresFlags = data[idx++];
            if (DEBUG_MODE) {
              console.log(`🎬 FRAME: num=${frameNum} flags=${suppresFlags}`);
            }
          }
        } else {
          // Protocolo estándar (34)
          const frameNum = data.readInt32LE(idx);
          idx += 4;
          lastFrameNum = frameNum;

          // deltaframe (4 bytes)
          if (idx + 4 <= data.length) {
            idx += 4;
          }
          // suppresscount (1 byte)
          if (idx < data.length) {
            idx++;
          }
        }

        // El resto del frame (areabits, playerstate, entities) es muy complejo
        // y requiere estado completo del cliente. No podemos parsearlo
        // correctamente, así que terminamos el parsing aquí.
        //
        // IMPORTANTE: Esto significa que cualquier svc_print, svc_stufftext, etc.
        // que venga DESPUÉS del frame en el mismo paquete será ignorado.
        // Sin embargo, en la práctica estos comandos suelen venir en paquetes
        // separados o antes del frame.
        return messages;
      }

      case SVC.PLAYERINFO:
      case SVC.PACKETENTITIES:
      case SVC.DELTAPACKETENTITIES:
        // Estos son complejos y requieren estado previo
        // Si llegamos aquí, ya no podemos seguir parseando
        return messages;

      case SVC.DOWNLOAD: {
        if (idx + 2 > data.length) return messages;
        const size = data.readInt16LE(idx);
        idx += 2;
        idx++; // percent
        if (size > 0) idx += size;
        break;
      }

      case SVC.ZPACKET: {
        // Paquete comprimido con zlib
        if (idx + 4 > data.length) return messages;
        const inlen = data.readUInt16LE(idx);
        idx += 2;
        const outlen = data.readUInt16LE(idx);
        idx += 2;

        if (idx + inlen > data.length) return messages;

        const compressed = data.slice(idx, idx + inlen);
        idx += inlen;

        const decompressed = decompressZlib(compressed);
        if (decompressed) {
          // Parsear recursivamente el contenido descomprimido
          const innerMsgs = parseGameMessage(decompressed, true);
          messages.push(...innerMsgs);
        }
        break;
      }

      case SVC.GAMESTATE: {
        // svc_gamestate (Q2PRO/AQtion) contiene configstrings y baselines comprimidos
        // Este es un mensaje "all-in-one" que reemplaza los stufftexts de
        // "cmd configstrings" y "cmd baselines"

        if (DEBUG_MODE) {
          console.log(`  📋 GAMESTATE: parseando desde pos ${idx}`);
        }

        // Parsear configstrings hasta encontrar el terminador (0x7fff o CS_END)
        const CS_END = 0x7fff;
        const MAX_CONFIGSTRINGS = 2080; // MAX_CONFIGSTRINGS de q2pro

        while (idx + 2 <= data.length) {
          const csIndex = data.readUInt16LE(idx);
          idx += 2;

          if (csIndex === CS_END || csIndex >= MAX_CONFIGSTRINGS) {
            if (DEBUG_MODE) {
              console.log(
                `  📋 GAMESTATE: fin de configstrings en index ${csIndex}`
              );
            }
            break;
          }

          const { text, nextIndex } = readCString(data, idx);
          idx = nextIndex;
          const cleanText = cleanQuakeString(text);

          if (cleanText) {
            messages.push({
              type: "configstring",
              index: csIndex,
              text: cleanText,
            });
          }
        }

        // Después vienen los baselines - formato complejo de entidades delta
        // No necesitamos parsearlos para capturar mensajes de consola
        // Pero debemos saltar al final del mensaje

        // Los baselines terminan con un entity number de 0
        // Formato: entity_bits (variable) + entity_state (variable)
        // Es muy complejo parsearlo sin conocer el estado previo,
        // así que terminamos aquí y dejamos que el servidor nos desconecte
        // si falta algo

        if (DEBUG_MODE) {
          console.log(`  📋 GAMESTATE: saltando baselines desde pos ${idx}`);
        }

        // Intentar encontrar más comandos después de los baselines
        // buscando opcodes conocidos
        return messages;
      }

      case SVC.SETTING: {
        // Server setting
        if (idx + 8 > data.length) return messages;
        idx += 4; // setting index
        idx += 4; // setting value
        break;
      }

      case SVC.CONFIGSTRINGSTREAM:
      case SVC.BASELINESTREAM:
        // Streams - requieren manejo especial
        return messages;

      default:
        // Opcode desconocido - intentar continuar si es nested
        if (DEBUG_MODE) {
          console.log(
            `⚠️ Opcode desconocido: ${cmd} (raw: ${opcode}) en pos ${idx - 1}`
          );
        }
        if (isNested) {
          // En paquetes anidados, intentamos continuar
          continue;
        }
        return messages;
    }
  }

  return messages;
}

/**
 * Guarda mensaje en log con formato limpio
 */
function logToFile(message) {
  const timestamp = getTimestamp();
  fs.appendFileSync(CONSOLE_LOG_FILE, `[${timestamp}] ${message}\n`);
}

/**
 * Muestra mensaje en consola y log
 */
function logConsoleMessage(prefix, message, logPrefix = null) {
  const shortTime = getShortTimestamp();
  console.log(`${prefix} [${shortTime}] ${message}`);
  if (logPrefix) {
    logToFile(`[${logPrefix}] ${message}`);
  }
}

/**
 * Crea paquete secuenciado (netchan)
 * Basado en Netchan_Transmit de q2pro
 *
 * Header format (new netchan, Q2PRO):
 * - 4 bytes: sequence number (bit 31 = reliable)
 * - 4 bytes: last received sequence (bit 31 = reliable ack)
 * - 1 byte: qport (solo 8 bits en Q2PRO)
 *
 * Header format (old netchan):
 * - 4 bytes: sequence number (bit 31 = reliable)
 * - 4 bytes: last received sequence (bit 31 = reliable ack)
 * - 2 bytes: qport
 */
function createSequencedPacket(data = null, reliable = false) {
  // Si enviamos reliable, alternar el bit de reliable
  let sendReliable = reliable;

  // Construir el valor de secuencia
  let w1 = outgoingSequence;
  if (sendReliable) {
    // Alternar el bit de reliable (0 o 1)
    reliableSequence ^= 1;
    lastReliableSequence = outgoingSequence;
    w1 |= 0x80000000;
  }

  // Construir el acknowledgment
  let w2 = incomingSequence;
  // El bit 31 del ack indica si recibimos el reliable del servidor
  if (incomingReliableSequence) {
    w2 |= 0x80000000;
  }

  // Crear el paquete
  const parts = [];

  // Escribir sequence (4 bytes)
  const seqBuffer = Buffer.alloc(4);
  seqBuffer.writeUInt32LE(w1 >>> 0, 0);
  parts.push(seqBuffer);

  // Escribir ack (4 bytes)
  const ackBuffer = Buffer.alloc(4);
  ackBuffer.writeUInt32LE(w2 >>> 0, 0);
  parts.push(ackBuffer);

  // Qport - en Q2PRO es 1 byte, en vanilla es 2 bytes
  if (serverProtocol >= PROTOCOL.VERSION_R1Q2) {
    // Q2PRO/R1Q2/AQtion: 1 byte qport
    const qportBuffer = Buffer.alloc(1);
    qportBuffer.writeUInt8(clientQport & 0xff, 0);
    parts.push(qportBuffer);
  } else {
    // Vanilla: 2 bytes qport
    const qportBuffer = Buffer.alloc(2);
    qportBuffer.writeUInt16LE(clientQport & 0xffff, 0);
    parts.push(qportBuffer);
  }

  // Datos
  if (data && data.length > 0) {
    parts.push(data);
  }

  // Incrementar secuencia para el próximo paquete
  outgoingSequence++;

  return Buffer.concat(parts);
}

/**
 * Envía respuesta secuenciada
 */
function sendSequencedResponse(data = null, reliable = false) {
  if (!isConnected) return;

  const packet = createSequencedPacket(data, reliable);
  socket.send(packet, SERVER_PORT, SERVER_IP);
}

/**
 * Envía comando string
 * El formato es: CLC.STRINGCMD (1 byte) + string terminado en \0
 */
function sendStringCmd(cmd, reliable = true) {
  if (!isConnected) {
    if (DEBUG_MODE) {
      console.log(`⚠️ sendStringCmd("${cmd}") ignorado - no conectado`);
    }
    return;
  }

  // El string debe ser solo ASCII y terminar en \0
  // No incluir caracteres de control adicionales
  const cleanCmd = cmd.replace(/[\r\n]/g, "").trim();

  // Crear buffer: 1 byte opcode + string + null terminator
  const stringBytes = Buffer.from(cleanCmd, "ascii");
  const cmdBuffer = Buffer.alloc(1 + stringBytes.length + 1);
  cmdBuffer[0] = CLC.STRINGCMD;
  stringBytes.copy(cmdBuffer, 1);
  cmdBuffer[1 + stringBytes.length] = 0; // null terminator

  const currentSeq = outgoingSequence;
  const packet = createSequencedPacket(cmdBuffer, reliable);

  if (DEBUG_MODE) {
    const hexCmd = Array.from(cmdBuffer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    const hexPacket = Array.from(packet)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    console.log(
      `📤 [${getShortTimestamp()}] CMD: "${cleanCmd}" (seq:${currentSeq})`
    );
    console.log(`   cmd: [${hexCmd}]`);
    console.log(`   pkt: [${hexPacket}]`);
  }

  socket.send(packet, SERVER_PORT, SERVER_IP);
}

// Estado para movimiento
let lastMoveTime = Date.now();
let moveSequence = 0;

/**
 * Crea un paquete de movimiento para protocolo vanilla (34)
 *
 * Formato vanilla:
 * - clc_move (1 byte) = 2
 * - checksum (1 byte)
 * - lastframe (4 bytes signed)
 * - 3 usercmd_t usando MSG_ReadDeltaUsercmd format
 *
 * Cada usercmd vanilla:
 * - bits (1 byte)
 * - msec (1 byte) - SIEMPRE
 * - lightlevel (1 byte) - SIEMPRE
 * - [campos según bits]
 */
function createMovePacketVanilla() {
  const buf = Buffer.alloc(64);
  let idx = 0;

  buf[idx++] = CLC.MOVE; // clc_move = 2

  // checksumIndex
  const checksumIdx = idx;
  buf[idx++] = 0; // placeholder

  // lastframe
  const frameToAck = lastFrameNum >= 0 ? lastFrameNum : -1;
  buf.writeInt32LE(frameToAck, idx);
  idx += 4;

  // 3 usercmds
  const now = Date.now();
  const totalMsec = Math.min(now - lastMoveTime, 255 * 3);
  lastMoveTime = now;
  const msecPerCmd = Math.min(Math.floor(totalMsec / 3), 100);

  for (let i = 0; i < 3; i++) {
    buf[idx++] = 0; // bits = 0 (no hay campos opcionales cambiados)
    buf[idx++] = msecPerCmd; // msec
    buf[idx++] = 0; // lightlevel
  }

  // Calcular checksum
  let checksum = 0;
  for (let i = checksumIdx + 1; i < idx; i++) {
    checksum ^= buf[i];
  }
  buf[checksumIdx] = checksum & 0xff;

  return buf.slice(0, idx);
}

/**
 * Escribe un valor usando codificación de bits (similar a MSG_WriteBits)
 * Para valores pequeños de 5 bits, simplemente escribimos el byte
 * ya que MSG_ReadBits lee del byte actual usando bits
 */
class BitWriter {
  constructor(buffer) {
    this.buffer = buffer;
    this.idx = 0;
    this.bitIdx = 0;
    this.currentByte = 0;
  }

  writeByte(value) {
    // Flush any pending bits first
    if (this.bitIdx > 0) {
      this.buffer[this.idx++] = this.currentByte;
      this.bitIdx = 0;
      this.currentByte = 0;
    }
    this.buffer[this.idx++] = value & 0xff;
  }

  writeInt32LE(value) {
    // Flush any pending bits first
    if (this.bitIdx > 0) {
      this.buffer[this.idx++] = this.currentByte;
      this.bitIdx = 0;
      this.currentByte = 0;
    }
    this.buffer.writeInt32LE(value, this.idx);
    this.idx += 4;
  }

  writeBits(value, numBits) {
    // Escribimos bits de menor a mayor
    for (let i = 0; i < numBits; i++) {
      if ((value & (1 << i)) !== 0) {
        this.currentByte |= 1 << this.bitIdx;
      }
      this.bitIdx++;
      if (this.bitIdx >= 8) {
        this.buffer[this.idx++] = this.currentByte;
        this.bitIdx = 0;
        this.currentByte = 0;
      }
    }
  }

  flush() {
    if (this.bitIdx > 0) {
      this.buffer[this.idx++] = this.currentByte;
      this.bitIdx = 0;
      this.currentByte = 0;
    }
    return this.idx;
  }
}

/**
 * Crea un paquete de movimiento para protocolo Q2PRO/AQtion
 * Basado en SV_NewClientExecuteMove de q2pro/src/server/user.c
 *
 * Formato Q2PRO/AQtion:
 * - clc_move_nodelta (10) o clc_move_batched (11) con numDups en bits altos
 *   Byte: (numDups << 5) | clc_move_nodelta
 * - lastframe (4 bytes) - solo si clc_move_batched
 * - lightlevel (1 byte)
 * - Para cada frame (numDups + 1):
 *   - numCmds (5 bits) - usando MSG_ReadBits
 *   - Para cada cmd: MSG_ReadDeltaUsercmd_Enhanced (bits byte + fields)
 *
 * MSG_ReadDeltaUsercmd_Enhanced:
 * - bits (1 byte)
 * - campos según bits (CM_* flags)
 */
function createMovePacketQ2PRO() {
  const buf = Buffer.alloc(64);
  const writer = new BitWriter(buf);

  // Para un cliente simple, usamos clc_move_nodelta (10) sin duplicados
  // numDups = 0, así que el byte es: (0 << 5) | 10 = 10
  const numDups = 0;
  const clcMoveNoDelta = CLC.MOVE_NODELTA; // = 10
  writer.writeByte((numDups << 5) | clcMoveNoDelta);

  // lightlevel (1 byte)
  writer.writeByte(0);

  // numCmds para este frame (5 bits, máximo 31)
  // Usamos solo 1 comando
  writer.writeBits(1, 5);

  // usercmd con bits = 0
  // MSG_ReadDeltaUsercmd_Enhanced lee un byte para los bits
  // bits = 0 significa que todos los campos son 0 (igual que anterior o NULL)
  writer.writeByte(0);

  const len = writer.flush();
  return buf.slice(0, len);
}

/**
 * Crea un paquete de movimiento para protocolo Q2PRO/AQtion con frame ack
 * Usando clc_move_batched que incluye lastframe
 */
function createMovePacketQ2PROBatched() {
  const buf = Buffer.alloc(64);
  const writer = new BitWriter(buf);

  // clc_move_batched (11) con numDups = 0
  const numDups = 0;
  const clcMoveBatched = CLC.MOVE_BATCHED; // = 11
  writer.writeByte((numDups << 5) | clcMoveBatched);

  // lastframe (4 bytes)
  const frameToAck = lastFrameNum >= 0 ? lastFrameNum : -1;
  writer.writeInt32LE(frameToAck);

  // lightlevel (1 byte)
  writer.writeByte(0);

  // numCmds (5 bits)
  writer.writeBits(1, 5);

  // usercmd con bits = 0
  writer.writeByte(0);

  const len = writer.flush();
  return buf.slice(0, len);
}

/**
 * Selecciona y crea el paquete de movimiento apropiado según el protocolo
 */
function createMovePacket() {
  if (
    serverProtocol === PROTOCOL.VERSION_Q2PRO ||
    serverProtocol === PROTOCOL.VERSION_AQTION
  ) {
    // Usar batched si tenemos un frame para confirmar
    if (lastFrameNum >= 0) {
      return createMovePacketQ2PROBatched();
    } else {
      return createMovePacketQ2PRO();
    }
  } else if (serverProtocol === PROTOCOL.VERSION_R1Q2) {
    // R1Q2 usa un formato similar a vanilla pero con algunas diferencias
    // Por ahora usamos vanilla
    return createMovePacketVanilla();
  } else {
    return createMovePacketVanilla();
  }
}

// Alias para compatibilidad
function createMovePacketWithTiming() {
  return createMovePacket();
}

/**
 * Envía keepalive
 * Para evitar problemas con el formato de los comandos de movimiento,
 * solo enviamos paquetes vacíos (keepalive) o NOP
 */
function sendMove() {
  if (!isConnected) return;

  // Como espectador pasivo, solo enviamos NOP para mantener la conexión
  // Los paquetes MOVE requieren un formato de bits complejo que el servidor rechaza
  // Con NOP, el cliente permanece conectado y recibe todos los mensajes de consola

  const nopPacket = Buffer.from([CLC.NOP]);
  sendSequencedResponse(nopPacket, false);

  if (DEBUG_MODE) {
    console.log(
      `📤 Enviando NOP keepalive (estado: ${connectionState}, frame: ${lastFrameNum})`
    );
  }
}

/**
 * Envía NOP
 */
function sendNop() {
  if (!isConnected) return;
  sendSequencedResponse(Buffer.from([CLC.NOP]), false);
}

/**
 * Solicita challenge
 */
function requestChallenge() {
  connectionState = "challenging";
  logConsoleMessage("📡", "Solicitando challenge al servidor...");
  socket.send(createGetChallengePacket(), SERVER_PORT, SERVER_IP);
}

/**
 * Conecta al servidor
 */
function connectToServer(challengeId) {
  if (challengeId) clientChallengeId = challengeId;

  connectionState = "connecting";
  logConsoleMessage("📡", `Conectando (challenge: ${clientChallengeId})...`);
  socket.send(createConnectPacket(clientChallengeId), SERVER_PORT, SERVER_IP);
}

/**
 * Envía comando "new"
 */
function sendNewCommand() {
  if (hasSentNew) return;
  hasSentNew = true;
  logConsoleMessage("🆕", "Solicitando datos del servidor (new)...");
  sendStringCmd("new");
}

/**
 * Envía comando "begin"
 */
function sendBeginCommand() {
  if (hasSentBegin) return;
  hasSentBegin = true;

  const beginCount = spawnCount || serverCount;
  logConsoleMessage("🎮", `Entrando al juego (begin ${beginCount})...`);

  // Enviar begin con el spawncount correcto
  sendStringCmd(`begin ${beginCount}`);

  // Marcar como spawned inmediatamente - el servidor debería empezar a enviar frames
  connectionState = "spawned";
  logConsoleMessage(
    "✅",
    "¡Conectado como espectador! Escuchando mensajes de consola..."
  );
  logToFile("CLIENTE EN JUEGO - ESCUCHANDO CONSOLA");
}

/**
 * Inicia heartbeat
 */
function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (keepAliveInterval) clearInterval(keepAliveInterval);

  // Movimiento cada 100ms cuando spawneado, cada 300ms durante handshake
  heartbeatInterval = setInterval(
    () => {
      if (!isConnected) return;

      if (connectionState === "spawned") {
        sendMove();
      } else {
        // Durante handshake, enviar keepalive
        sendSequencedResponse();
      }
    },
    connectionState === "spawned" ? 100 : 300
  );

  // NOP backup cada 10 segundos
  keepAliveInterval = setInterval(() => {
    if (isConnected) sendNop();
  }, 10000);
}

// Flags para saber si respondimos a comandos obligatorios
let respondedVersion = false;
let respondedAcToken = false;
let sentConfigstrings = false;
let sentBaselines = false;

// Cola de comandos que deben enviarse antes del begin
let pendingCommands = [];
let awaitingBegin = false;

// Estado del handshake
let handshakeState = "new"; // new, configstrings, baselines, precache, begin

/**
 * Procesa los comandos stufftext y programa las respuestas
 * El servidor envía varios comandos y espera las respuestas en orden específico
 *
 * El flujo típico del handshake en Q2/AQtion es:
 * 1. Cliente envía "new"
 * 2. Servidor envía svc_serverdata
 * 3. Servidor envía stufftext "cmd configstrings <offset>"
 * 4. Cliente responde "configstrings <offset>"
 * 5. Servidor envía configstrings, luego stufftext "cmd baselines <offset>"
 * 6. Cliente responde "baselines <offset>"
 * 7. Servidor envía baselines, luego stufftext "precache <spawncount>"
 * 8. Cliente responde "begin <spawncount>"
 * 9. Servidor empieza a enviar svc_frame
 */
function handleStufftext(text) {
  const shortTime = getShortTimestamp();

  // El servidor puede enviar múltiples comandos en un solo stufftext
  const lines = text.split("\n");

  for (const line of lines) {
    const cmd = line.trim();
    if (!cmd) continue;

    console.log(`📝 [${shortTime}] Stufftext: "${cmd}"`);

    // El servidor envía comandos con prefijo \x7F (DEL character) que es un marcador especial
    // Formato del servidor: "cmd \x7Fc version $version"
    // El cliente debe responder: "\x7Fc version <nombre> <version>"

    // cmd \x7Fc version $version - el servidor quiere saber nuestra versión
    // \x7F = 0x7F = DEL = 127 en decimal
    // El servidor lo escribe como \177 en octal
    if (cmd.includes("\x7Fc version") || cmd.includes("c version $version")) {
      if (!respondedVersion) {
        respondedVersion = true;
        // Responder con el prefijo \x7Fc
        pendingCommands.push("\x7Fc version Q2Logger 1.0");
        console.log(`📝 [${shortTime}] Encolando respuesta: \\x7Fc version`);
      }
      continue;
    }

    // cmd \x7Fc actoken $actoken - token anti-cheat
    if (cmd.includes("\x7Fc actoken") || cmd.includes("c actoken $actoken")) {
      if (!respondedAcToken) {
        respondedAcToken = true;
        pendingCommands.push("\x7Fc actoken 0");
        console.log(`📝 [${shortTime}] Encolando respuesta: \\x7Fc actoken`);
      }
      continue;
    }

    // cmd \x7Fc check - anti-cheat check
    if (cmd.includes("\x7Fc check") || cmd.includes("c check")) {
      pendingCommands.push("\x7Fc check 0");
      console.log(`📝 [${shortTime}] Encolando respuesta: \\x7Fc check`);
      continue;
    }

    // cmd configstrings <offset> - solicitar configstrings desde offset
    // El servidor envía esto después de serverdata
    if (cmd.startsWith("cmd configstrings")) {
      const match = cmd.match(/cmd configstrings\s*(\d*)/);
      const offset = match && match[1] ? match[1] : "0";

      if (!sentConfigstrings) {
        sentConfigstrings = true;
        pendingCommands.push(`configstrings ${offset}`);
        handshakeState = "configstrings";
        console.log(
          `📝 [${shortTime}] Solicitando configstrings desde ${offset}`
        );
      }
      continue;
    }

    // cmd baselines <offset> - solicitar baselines desde offset
    // El servidor envía esto después de todos los configstrings
    if (cmd.startsWith("cmd baselines")) {
      const match = cmd.match(/cmd baselines\s*(\d*)/);
      const offset = match && match[1] ? match[1] : "0";

      if (!sentBaselines) {
        sentBaselines = true;
        pendingCommands.push(`baselines ${offset}`);
        handshakeState = "baselines";
        console.log(`📝 [${shortTime}] Solicitando baselines desde ${offset}`);
      }
      continue;
    }

    // Precache - señal para enviar begin (después de enviar las respuestas pendientes)
    // Formato: "precache <spawncount>" o solo "precache"
    if (cmd.startsWith("precache") && !precacheReceived) {
      precacheReceived = true;
      handshakeState = "precache";

      const match = cmd.match(/precache\s+(\d+)/);
      if (match) {
        spawnCount = parseInt(match[1]);
      } else {
        spawnCount = serverCount;
      }

      logConsoleMessage("📦", `Precache recibido (spawn: ${spawnCount})`);

      if (PASSIVE_MODE) {
        logConsoleMessage(
          "👁️",
          "Modo pasivo - Escuchando sin entrar al juego..."
        );
        connectionState = "spawned";
        logToFile("MODO PASIVO - ESCUCHANDO CONSOLA");
      } else {
        // Marcar que debemos enviar begin después de procesar los comandos pendientes
        awaitingBegin = true;
      }
      continue;
    }

    // "skins" - en protocolo vanilla, el servidor envía "skins" cuando está listo
    // Esto es equivalente a precache en Q2PRO
    if (cmd === "skins" && !precacheReceived) {
      precacheReceived = true;
      logConsoleMessage(
        "📦",
        `Skins recibido - listo para begin (spawn: ${serverCount})`
      );
      spawnCount = serverCount;

      if (PASSIVE_MODE) {
        logConsoleMessage(
          "👁️",
          "Modo pasivo - Escuchando sin entrar al juego..."
        );
        connectionState = "spawned";
        logToFile("MODO PASIVO - ESCUCHANDO CONSOLA");
      } else {
        awaitingBegin = true;
      }
      continue;
    }

    // Comandos de configuración del cliente - ignorar pero loguear
    if (
      cmd.startsWith("cl_") ||
      cmd.startsWith("set ") ||
      cmd.startsWith("alias ") ||
      cmd.startsWith("exec ") ||
      cmd.startsWith("bind ") ||
      cmd.startsWith("unbind ")
    ) {
      if (DEBUG_MODE) {
        console.log(
          `📝 [${shortTime}] Ignorando comando de config: "${cmd.substring(
            0,
            50
          )}"`
        );
      }
      continue;
    }

    // Comando reconnect del servidor (cambio de mapa, etc.)
    if (cmd === "reconnect" || cmd.startsWith("reconnect")) {
      logConsoleMessage("🔄", "Servidor solicita reconexión (cambio de mapa)");
      logToFile("[RECONNECT] Servidor solicita reconexión");
      resetConnectionState();
      setTimeout(() => requestChallenge(), 500);
      return;
    }

    // Cambio de mapa
    if (cmd.startsWith("changing")) {
      const mapMatch = cmd.match(/map=(\S+)/);
      if (mapMatch) {
        logConsoleMessage(
          "🗺️",
          `Cambiando a mapa: ${mapMatch[1]}`,
          "MAP_CHANGE"
        );
      }
      continue;
    }

    // Comando disconnect
    if (cmd === "disconnect") {
      logConsoleMessage(
        "🔌",
        "Servidor envió comando disconnect via stufftext"
      );
      handleDisconnect();
      return;
    }

    // Cualquier otro comando - loguear si está en modo debug
    if (DEBUG_MODE) {
      console.log(
        `📝 [${shortTime}] Stufftext no manejado: "${cmd.substring(0, 80)}"`
      );
    }
  }

  // Después de parsear todos los comandos, enviar las respuestas pendientes
  processPendingCommands();
}

/**
 * Envía los comandos pendientes al servidor
 * Esto asegura que las respuestas se envíen ANTES del begin
 */
function processPendingCommands() {
  if (pendingCommands.length === 0 && !awaitingBegin) {
    return;
  }

  const shortTime = getShortTimestamp();

  // Enviar todos los comandos pendientes primero
  while (pendingCommands.length > 0) {
    const cmd = pendingCommands.shift();
    sendStringCmd(cmd);
    if (DEBUG_MODE) console.log(`📤 [${shortTime}] Enviado: "${cmd}"`);
  }

  // Ahora que enviamos las respuestas, podemos enviar begin
  // Pero debemos esperar más tiempo para que el servidor procese
  if (awaitingBegin && !hasSentBegin) {
    awaitingBegin = false;
    // Esperar más tiempo para que el servidor procese las respuestas
    // El servidor necesita tiempo para validar version y actoken
    setTimeout(() => sendBeginCommand(), 500);
  }
}

/**
 * Contador de paquetes recibidos después de enviar respuestas
 * El servidor debe confirmar recepción antes de enviar begin
 */
let packetsAfterResponses = 0;

/**
 * Procesa paquete del servidor
 */
function handleServerPacket(buffer) {
  lastPacketTime = Date.now();
  const parsed = parseOOBPacket(buffer);

  if (!parsed) return;

  const shortTime = getShortTimestamp();

  switch (parsed.type) {
    case "challenge":
      logConsoleMessage("✅", `Challenge: ${parsed.challengeId}`);
      if (parsed.supportedProtocols && parsed.supportedProtocols.length > 0) {
        logConsoleMessage(
          "📋",
          `Protocolos soportados: ${parsed.supportedProtocols.join(", ")}`
        );
        // Usar protocolo AQtion (38) si está disponible - el servidor es AQ2
        // Este protocolo es específico para Action Quake 2
        if (parsed.supportedProtocols.includes(PROTOCOL.VERSION_AQTION)) {
          serverProtocol = PROTOCOL.VERSION_AQTION;
        } else if (parsed.supportedProtocols.includes(PROTOCOL.VERSION_Q2PRO)) {
          serverProtocol = PROTOCOL.VERSION_Q2PRO;
        } else if (parsed.supportedProtocols.includes(PROTOCOL.VERSION_R1Q2)) {
          serverProtocol = PROTOCOL.VERSION_R1Q2;
        } else if (
          parsed.supportedProtocols.includes(PROTOCOL.VERSION_DEFAULT)
        ) {
          serverProtocol = PROTOCOL.VERSION_DEFAULT;
        }
        logConsoleMessage("📋", `Usando protocolo: ${serverProtocol}`);
      }
      setTimeout(() => connectToServer(parsed.challengeId), 100);
      break;

    case "client_connect":
      console.log(`✅ [${shortTime}] ¡Conexión aceptada!`);
      if (parsed.params.nc) {
        netchanType = parseInt(parsed.params.nc) || 1;
      }
      console.log(`${"─".repeat(60)}`);
      isConnected = true;
      connectionState = "connected";
      reconnectAttempts = 0;
      logToFile("CONEXION ESTABLECIDA");
      startHeartbeat();
      setTimeout(() => sendNewCommand(), 200);
      break;

    case "print":
      if (parsed.message.trim()) {
        logConsoleMessage("📢", parsed.message, "SERVER");
      }
      break;

    case "disconnect":
      logConsoleMessage("❌", `Desconectado: ${parsed.reason}`, "DISCONNECT");
      handleDisconnect();
      break;

    case "statusResponse":
      // Respuesta a query de status (modo monitor)
      handleStatusResponse(parsed.content);
      break;

    case "sequenced":
      if (parsed.error) return;

      // Procesar netchan - actualizar estado de secuencias
      // Basado en Netchan_Process de q2pro

      // Verificar si es un paquete duplicado (ignorar bits de reliable/fragment al comparar)
      if (
        parsed.sequence <= incomingSequence &&
        incomingSequence > 0 &&
        !parsed.fragmented
      ) {
        if (DEBUG_MODE) {
          console.log(
            `⚠️ Paquete duplicado: seq ${parsed.sequence} <= ${incomingSequence}`
          );
        }
        return;
      }

      // Verificar el acknowledgment del servidor
      incomingAcknowledged = parsed.ack;
      if (parsed.reliableAck !== (incomingReliableAcknowledged === 1)) {
        incomingReliableAcknowledged = parsed.reliableAck ? 1 : 0;
      }

      if (DEBUG_MODE && (parsed.hasData || parsed.fragmented)) {
        console.log(
          `📥 seq:${parsed.sequence} ack:${parsed.ack} reliable:${
            parsed.reliable
          } fragmented:${parsed.fragmented} dataLen:${
            parsed.data ? parsed.data.length : 0
          }`
        );
      }

      // Manejar fragmentación
      if (parsed.fragmented) {
        // Si es una nueva secuencia de fragmentos, iniciar buffer
        if (fragmentSequence !== parsed.sequence) {
          fragmentSequence = parsed.sequence;
          fragmentBuffer = Buffer.alloc(0);
        }

        // Verificar que el offset sea correcto
        if (parsed.fragmentOffset !== fragmentBuffer.length) {
          if (DEBUG_MODE) {
            console.log(
              `⚠️ Fragmento fuera de orden: offset ${parsed.fragmentOffset} != ${fragmentBuffer.length}`
            );
          }
          return;
        }

        // Agregar datos al buffer de fragmentos
        if (parsed.data && parsed.data.length > 0) {
          fragmentBuffer = Buffer.concat([fragmentBuffer, parsed.data]);
        }

        // Si hay más fragmentos, esperar
        if (parsed.moreFragments) {
          if (DEBUG_MODE) {
            console.log(
              `📦 Fragmento recibido, esperando más... (${fragmentBuffer.length} bytes acumulados)`
            );
          }
          return;
        }

        // Mensaje completo - usar el buffer de fragmentos como datos
        parsed.data = fragmentBuffer;
        parsed.hasData = fragmentBuffer.length > 0;
        fragmentBuffer = Buffer.alloc(0);

        if (DEBUG_MODE) {
          console.log(
            `📦 Mensaje fragmentado completo: ${parsed.data.length} bytes`
          );
        }
      }

      // Actualizar secuencia entrante
      incomingSequence = parsed.sequence;

      // Si el servidor envió un reliable, alternar el bit
      if (parsed.reliable) {
        incomingReliableSequence ^= 1;
        if (DEBUG_MODE) {
          console.log(
            `📥 Reliable recibido, nuevo bit: ${incomingReliableSequence}`
          );
        }
      }

      // Procesar datos
      if (parsed.hasData && parsed.data) {
        // Parsear mensajes - usar processServerData para manejar posible compresión
        const msgs = processServerData(parsed.data);

        for (const m of msgs) {
          switch (m.type) {
            case "serverdata":
              // Detectar cambio de mapa
              if (currentMapName && currentMapName !== m.mapName) {
                logConsoleMessage(
                  "🗺️",
                  `Cambio de mapa: ${currentMapName} → ${m.mapName}`,
                  "MAP_CHANGE"
                );
                logToFile(`[MAP_CHANGE] ${currentMapName} → ${m.mapName}`);

                // Reconectar para el nuevo mapa
                currentMapName = m.mapName;
                serverCount = m.serverCount;
                serverProtocol = m.protocol;

                // Reiniciar estado pero mantener conexión base
                hasSentNew = false;
                hasSentBegin = false;
                hasReceivedServerData = false;
                respondedVersion = false;
                respondedAcToken = false;
                pendingCommands = [];
                awaitingBegin = false;
                lastFrameNum = -1;
                spawnCount = 0;
                configStrings = {};

                // Enviar "new" para obtener los datos del nuevo mapa
                logConsoleMessage("🔄", "Reconectando al nuevo mapa...");
                setTimeout(() => sendNewCommand(), 500);
                return;
              }

              logConsoleMessage(
                "🗺️",
                `Mapa: ${m.mapName} | Mod: ${m.gameDir} | Protocolo: ${m.protocol}`,
                "SERVERDATA"
              );
              currentMapName = m.mapName;
              hasServerData = true;
              serverCount = m.serverCount;
              serverProtocol = m.protocol; // Actualizar protocolo real del servidor
              break;

            case "configstring":
              configStrings[m.index] = m.text;
              // Nombres de jugadores en 1408-1663
              if (m.index >= 1408 && m.index < 1664 && m.text) {
                const playerNum = m.index - 1408;
                const name = m.text.split("\\")[0];
                if (name && name !== playerNames[playerNum]) {
                  playerNames[playerNum] = name;
                  logConsoleMessage(
                    "👤",
                    `Jugador #${playerNum}: ${name}`,
                    "PLAYER"
                  );
                }
              }
              // Mapa
              else if (m.index === 0 && m.text) {
                logConsoleMessage("🗺️", `Mapa: ${m.text}`, "MAP");
              }
              break;

            case "print":
              if (m.text) {
                const levelName = PRINT_LEVELS[m.level] || "MSG";
                const prefix = m.level === 3 ? "💬" : "🖥️";
                logConsoleMessage(prefix, m.text, levelName);
              }
              break;

            case "centerprint":
              if (m.text) {
                logConsoleMessage("📣", `[CENTER] ${m.text}`, "CENTER");
              }
              break;

            case "stufftext":
              handleStufftext(m.text);
              break;

            case "server_disconnect":
              logConsoleMessage(
                "❌",
                "Servidor envió disconnect",
                "DISCONNECT"
              );
              handleDisconnect();
              return;

            case "reconnect":
              logConsoleMessage("🔄", "Servidor solicita reconexión");
              resetConnectionState();
              setTimeout(() => requestChallenge(), 1000);
              return;
          }
        }
      }

      // Responder al servidor para mantener la conexión
      sendSequencedResponse();
      break;

    case "ack":
      if (DEBUG_MODE) console.log(`✓ [${shortTime}] ACK`);
      break;

    case "unknown_oob":
      if (DEBUG_MODE) {
        console.log(
          `❓ [${shortTime}] OOB desconocido: ${parsed.raw.substring(0, 50)}`
        );
      }
      break;
  }
}

/**
 * Maneja desconexión
 */
function handleDisconnect() {
  isConnected = false;
  connectionState = "disconnected";

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }

  // Intentar reconectar
  if (reconnectAttempts < maxReconnectAttempts) {
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, 30000);
    logConsoleMessage(
      "🔄",
      `Reconectando en ${
        delay / 1000
      }s (intento ${reconnectAttempts}/${maxReconnectAttempts})...`
    );
    resetConnectionState();
    setTimeout(() => requestChallenge(), delay);
  } else {
    logConsoleMessage("❌", "Máximo de intentos de reconexión alcanzado");
  }
}

/**
 * Resetea estado de conexión
 */
function resetConnectionState() {
  hasSentNew = false;
  hasSentBegin = false;
  precacheReceived = false;
  hasServerData = false;

  // Reset netchan state
  incomingSequence = 0;
  incomingAcknowledged = 0;
  incomingReliableAcknowledged = 0;
  incomingReliableSequence = 0;
  outgoingSequence = 1;
  reliableSequence = 0;
  lastReliableSequence = 0;

  lastFrameNum = -1;
  configStrings = {};
  playerNames = {};
  respondedVersion = false;
  respondedAcToken = false;
  sentConfigstrings = false;
  sentBaselines = false;
  currentMapName = ""; // Reset mapa actual

  // Reset pending commands
  pendingCommands = [];
  awaitingBegin = false;
  handshakeState = "new";

  // Reset move state
  lastMoveTime = Date.now();
  moveSequence = 0;
}

// Estado del modo monitor
let lastServerStatus = null;
let monitorInterval = null;

/**
 * Parsea respuesta de status OOB
 */
function parseStatusResponse(content) {
  const lines = content.split("\n");
  const result = {
    info: {},
    players: [],
  };

  // Primera línea es "statusResponse" o similar
  // Segunda línea es el serverinfo
  if (lines.length >= 2) {
    const infoLine = lines[1];
    const parts = infoLine.split("\\").filter((p) => p);
    for (let i = 0; i < parts.length - 1; i += 2) {
      result.info[parts[i]] = parts[i + 1];
    }
  }

  // Líneas siguientes son jugadores: "score ping name"
  for (let i = 2; i < lines.length; i++) {
    const playerLine = lines[i].trim();
    if (!playerLine) continue;
    const match = playerLine.match(/^(-?\d+)\s+(\d+)\s+"(.+)"$/);
    if (match) {
      result.players.push({
        score: parseInt(match[1]),
        ping: parseInt(match[2]),
        name: cleanQuakeString(match[3]),
      });
    }
  }

  return result;
}

/**
 * Envía query de status OOB
 */
function sendStatusQuery() {
  socket.send(createOOBPacket("status"), SERVER_PORT, SERVER_IP);
}

/**
 * Maneja respuesta de status en modo monitor
 */
function handleStatusResponse(content) {
  const status = parseStatusResponse(content);
  const shortTime = getShortTimestamp();

  // Detectar cambios en jugadores
  if (lastServerStatus) {
    const oldPlayers = new Set(lastServerStatus.players.map((p) => p.name));
    const newPlayers = new Set(status.players.map((p) => p.name));

    // Jugadores que se conectaron
    for (const player of status.players) {
      if (!oldPlayers.has(player.name)) {
        logConsoleMessage("👤", `${player.name} se conectó`, "PLAYER_JOIN");
      }
    }

    // Jugadores que se desconectaron
    for (const player of lastServerStatus.players) {
      if (!newPlayers.has(player.name)) {
        logConsoleMessage("👋", `${player.name} se desconectó`, "PLAYER_LEAVE");
      }
    }

    // Detectar cambio de mapa
    if (
      status.info.mapname &&
      lastServerStatus.info.mapname !== status.info.mapname
    ) {
      logConsoleMessage(
        "🗺️",
        `Mapa cambiado: ${lastServerStatus.info.mapname} → ${status.info.mapname}`,
        "MAP_CHANGE"
      );
    }
  } else {
    // Primera vez - mostrar estado inicial
    const mapName = status.info.mapname || "desconocido";
    const hostname = cleanQuakeString(status.info.hostname || "Servidor Q2");
    const playerCount = status.players.length;
    const maxClients = status.info.maxclients || "?";

    logConsoleMessage("🎮", `Servidor: ${hostname}`);
    logConsoleMessage("🗺️", `Mapa: ${mapName}`, "MAP");
    logConsoleMessage(
      "👥",
      `Jugadores: ${playerCount}/${maxClients}`,
      "PLAYERS"
    );

    if (status.players.length > 0) {
      status.players.forEach((p) => {
        logConsoleMessage("👤", `  ${p.name} (ping: ${p.ping}ms)`, "PLAYER");
      });
    }
  }

  lastServerStatus = status;
}

/**
 * Handler de paquetes para modo monitor
 */
function handleMonitorPacket(buffer) {
  // Solo procesar paquetes OOB
  if (
    buffer.length < 4 ||
    buffer[0] !== 0xff ||
    buffer[1] !== 0xff ||
    buffer[2] !== 0xff ||
    buffer[3] !== 0xff
  ) {
    return;
  }

  const content = buffer.slice(4).toString("latin1");
  const lines = content.split("\n");
  const firstLine = lines[0].trim();

  // statusResponse - el formato estándar
  if (
    firstLine === "statusResponse" ||
    firstLine.startsWith("statusResponse")
  ) {
    handleStatusResponseMonitor(content);
  }
  // print seguido de infostring (formato alternativo de algunos servidores)
  else if (
    firstLine.startsWith("print") &&
    lines.length >= 2 &&
    lines[1].startsWith("\\")
  ) {
    // Reconstruir como statusResponse
    const fakeStatus = "statusResponse\n" + lines.slice(1).join("\n");
    handleStatusResponseMonitor(fakeStatus);
  }
  // print normal (mensajes del servidor)
  else if (firstLine.startsWith("print")) {
    const message = cleanQuakeString(content.substring(6));
    if (message.trim()) {
      logConsoleMessage("📢", message, "SERVER");
    }
  } else if (DEBUG_MODE) {
    console.log(
      `❓ [${getShortTimestamp()}] OOB: ${firstLine.substring(0, 40)}`
    );
  }
}

/**
 * Maneja respuesta de status en modo monitor (versión mejorada)
 */
function handleStatusResponseMonitor(content) {
  const status = parseStatusResponse(content);

  // Detectar cambios en jugadores
  if (lastServerStatus) {
    const oldPlayers = new Set(lastServerStatus.players.map((p) => p.name));
    const newPlayers = new Set(status.players.map((p) => p.name));

    // Jugadores que se conectaron
    for (const player of status.players) {
      if (!oldPlayers.has(player.name)) {
        logConsoleMessage("👤", `${player.name} se conectó`, "PLAYER_JOIN");
      }
    }

    // Jugadores que se desconectaron
    for (const player of lastServerStatus.players) {
      if (!newPlayers.has(player.name)) {
        logConsoleMessage("👋", `${player.name} se desconectó`, "PLAYER_LEAVE");
      }
    }

    // Detectar cambio de mapa
    if (
      status.info.mapname &&
      lastServerStatus.info.mapname !== status.info.mapname
    ) {
      logConsoleMessage(
        "🗺️",
        `Mapa cambiado: ${lastServerStatus.info.mapname} → ${status.info.mapname}`,
        "MAP_CHANGE"
      );
    }
  } else {
    // Primera vez - mostrar estado inicial
    const mapName = status.info.mapname || "desconocido";
    const hostname = cleanQuakeString(status.info.hostname || "Servidor Q2");
    const playerCount = status.players.length;
    const maxClients = status.info.maxclients || "?";

    logConsoleMessage("🎮", `Servidor: ${hostname}`);
    logConsoleMessage("🗺️", `Mapa: ${mapName}`, "MAP");
    logConsoleMessage(
      "👥",
      `Jugadores: ${playerCount}/${maxClients}`,
      "PLAYERS"
    );

    if (status.players.length > 0) {
      status.players.forEach((p) => {
        logConsoleMessage("👤", `  ${p.name} (ping: ${p.ping}ms)`, "PLAYER");
      });
    }
  }

  lastServerStatus = status;
}

/**
 * Inicia modo monitor
 */
function startMonitorMode() {
  logConsoleMessage(
    "📊",
    "Modo MONITOR iniciado - Polling cada " + MONITOR_INTERVAL / 1000 + "s"
  );
  logToFile("MODO MONITOR INICIADO");

  // Handler de paquetes
  socket.on("message", handleMonitorPacket);

  // Primera query
  sendStatusQuery();

  // Polling periódico
  monitorInterval = setInterval(() => {
    sendStatusQuery();
  }, MONITOR_INTERVAL);
}

/**
 * Inicializa el cliente
 */
function initialize() {
  // Crear archivo de log
  const modeText = MONITOR_MODE
    ? "MONITOR"
    : PASSIVE_MODE
    ? "PASIVO"
    : "CLIENTE";
  fs.writeFileSync(
    CONSOLE_LOG_FILE,
    `${"═".repeat(60)}\n` +
      `QUAKE 2 ${modeText} LOG - ${getTimestamp()}\n` +
      `Servidor: ${SERVER_IP}:${SERVER_PORT}\n` +
      `${"═".repeat(60)}\n\n`
  );

  console.log(`\n🎮 ${"═".repeat(50)}`);
  console.log(`   QUAKE 2 CONSOLE CLIENT`);
  console.log(`${"═".repeat(54)}`);
  console.log(`🎯 Servidor: ${SERVER_IP}:${SERVER_PORT}`);
  console.log(`💾 Log: ${CONSOLE_LOG_FILE}`);
  console.log(`🔧 Debug: ${DEBUG_MODE ? "ON" : "OFF"}`);
  if (MONITOR_MODE) {
    console.log(
      `📊 Modo: MONITOR (polling status cada ${MONITOR_INTERVAL / 1000}s)`
    );
  } else if (PASSIVE_MODE) {
    console.log(`👁️  Modo: PASIVO (solo escucha, no entra al juego)`);
  }
  console.log(`⌨️  Ctrl+C para salir`);
  console.log(`${"─".repeat(54)}\n`);

  socket.bind(() => {
    const addr = socket.address();
    console.log(`🔌 Socket: ${addr.address}:${addr.port}\n`);

    if (MONITOR_MODE) {
      // Modo monitor - solo queries OOB
      startMonitorMode();
    } else {
      // Modo cliente - intentar conexión completa
      socket.on("message", handleServerPacket);
      requestChallenge();

      // Timeout de conexión inicial
      const initTimeout = setTimeout(() => {
        if (!isConnected) {
          console.log(`\n⏱️  Timeout: No se pudo conectar`);
          console.log(
            `💡 Prueba el modo MONITOR: MONITOR=1 node quake2client.js`
          );
        }
      }, 15000);

      // Cancelar timeout si conectamos
      const checkConnection = setInterval(() => {
        if (isConnected) {
          clearTimeout(initTimeout);
          clearInterval(checkConnection);
        }
      }, 1000);
    }
  });

  socket.on("error", (err) => {
    console.error(`\n❌ Error socket: ${err.message}`);
    cleanup();
    process.exit(1);
  });
}

/**
 * Limpieza
 */
function cleanup() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (monitorInterval) clearInterval(monitorInterval);

  if (isConnected) {
    socket.send(createOOBPacket("disconnect"), SERVER_PORT, SERVER_IP);
  }
  socket.close();
}

// Ctrl+C
process.on("SIGINT", () => {
  console.log(`\n\n${"─".repeat(54)}`);
  console.log(`🛑 Cerrando cliente...`);
  logToFile("CLIENTE CERRADO POR USUARIO");
  cleanup();
  console.log(`💾 Log guardado en: ${CONSOLE_LOG_FILE}`);
  console.log(`👋 ¡Hasta luego!\n`);
  process.exit(0);
});

// Iniciar
initialize();
