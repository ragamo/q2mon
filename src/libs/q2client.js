import dgram from "dgram";
import zlib from "zlib";
import { EventEmitter } from "events";

// ============================================================================
// CONSTANTES DEL PROTOCOLO
// ============================================================================

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
  ZPACKET: 21,
  ZDOWNLOAD: 22,
  GAMESTATE: 23,
  SETTING: 24,
  CONFIGSTRINGSTREAM: 25,
  BASELINESTREAM: 26,
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

// Bits de netchan
const REL_BIT = 0x80000000;
const FRG_BIT = 0x40000000;
const NEW_MASK = FRG_BIT - 1;

// Entity state flags (U_* bits) - para parsing de entidades
const U_ORIGIN1 = 1 << 0;
const U_ORIGIN2 = 1 << 1;
const U_ANGLE2 = 1 << 2;
const U_ANGLE3 = 1 << 3;
const U_FRAME8 = 1 << 4;
const U_EVENT = 1 << 5;
const U_REMOVE = 1 << 6;
const U_MOREBITS1 = 1 << 7;
const U_NUMBER16 = 1 << 8;
const U_ORIGIN3 = 1 << 9;
const U_ANGLE1 = 1 << 10;
const U_MODEL = 1 << 11;
const U_RENDERFX8 = 1 << 12;
const U_EFFECTS8 = 1 << 14;
const U_MOREBITS2 = 1 << 15;
const U_SKIN8 = 1 << 16;
const U_FRAME16 = 1 << 17;
const U_RENDERFX16 = 1 << 18;
const U_EFFECTS16 = 1 << 19;
const U_MODEL2 = 1 << 20;
const U_MODEL3 = 1 << 21;
const U_MODEL4 = 1 << 22;
const U_MOREBITS3 = 1 << 23;
const U_OLDORIGIN = 1 << 24;
const U_SKIN16 = 1 << 25;
const U_SOUND = 1 << 26;
const U_SOLID = 1 << 27;

// Player state flags (PS_* bits)
const PS_M_TYPE = 1 << 0;
const PS_M_ORIGIN = 1 << 1;
const PS_M_VELOCITY = 1 << 2;
const PS_M_TIME = 1 << 3;
const PS_M_FLAGS = 1 << 4;
const PS_M_GRAVITY = 1 << 5;
const PS_M_DELTA_ANGLES = 1 << 6;
const PS_VIEWOFFSET = 1 << 7;
const PS_VIEWANGLES = 1 << 8;
const PS_KICKANGLES = 1 << 9;
const PS_BLEND = 1 << 10;
const PS_FOV = 1 << 11;
const PS_WEAPONINDEX = 1 << 12;
const PS_WEAPONFRAME = 1 << 13;
const PS_RDFLAGS = 1 << 14;

// Máximo de entidades
const MAX_EDICTS = 1024;
const MAX_CLIENTS = 256;

// ============================================================================
// CLASE ENTITY TRACKER
// ============================================================================

/**
 * Mantiene el estado de todas las entidades del juego
 */
class EntityTracker {
  constructor() {
    this.baselines = new Array(MAX_EDICTS)
      .fill(null)
      .map(() => this.createEmptyEntity());
    this.entities = new Array(MAX_EDICTS)
      .fill(null)
      .map(() => this.createEmptyEntity());
    this.playerState = this.createEmptyPlayerState();
    this.previousPlayerState = this.createEmptyPlayerState();
  }

  createEmptyEntity() {
    return {
      number: 0,
      modelindex: 0,
      modelindex2: 0,
      modelindex3: 0,
      modelindex4: 0,
      frame: 0,
      skinnum: 0,
      effects: 0,
      renderfx: 0,
      origin: { x: 0, y: 0, z: 0 },
      angles: { pitch: 0, yaw: 0, roll: 0 },
      old_origin: { x: 0, y: 0, z: 0 },
      sound: 0,
      event: 0,
      solid: 0,
      active: false,
    };
  }

  createEmptyPlayerState() {
    return {
      pmove: {
        pm_type: 0,
        origin: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        pm_flags: 0,
        pm_time: 0,
        gravity: 0,
        delta_angles: { pitch: 0, yaw: 0, roll: 0 },
      },
      viewoffset: { x: 0, y: 0, z: 0 },
      viewangles: { pitch: 0, yaw: 0, roll: 0 },
      kick_angles: { pitch: 0, yaw: 0, roll: 0 },
      gunindex: 0,
      gunframe: 0,
      blend: [0, 0, 0, 0],
      fov: 90,
      rdflags: 0,
      stats: new Array(32).fill(0),
    };
  }

  setBaseline(entityNum, state) {
    if (entityNum >= 0 && entityNum < MAX_EDICTS) {
      this.baselines[entityNum] = { ...state };
    }
  }

  updateEntity(entityNum, deltaState) {
    if (entityNum < 0 || entityNum >= MAX_EDICTS) return null;

    const entity = this.entities[entityNum];
    const baseline = this.baselines[entityNum];

    // Aplicar delta sobre baseline o estado actual
    Object.assign(entity, deltaState);
    entity.number = entityNum;
    entity.active = !deltaState.removed;

    return entity;
  }

  getEntity(entityNum) {
    if (entityNum >= 0 && entityNum < MAX_EDICTS) {
      return this.entities[entityNum];
    }
    return null;
  }

  updatePlayerState(delta) {
    this.previousPlayerState = { ...this.playerState };
    Object.assign(this.playerState, delta);
    return this.playerState;
  }

  reset() {
    this.baselines = new Array(MAX_EDICTS)
      .fill(null)
      .map(() => this.createEmptyEntity());
    this.entities = new Array(MAX_EDICTS)
      .fill(null)
      .map(() => this.createEmptyEntity());
    this.playerState = this.createEmptyPlayerState();
    this.previousPlayerState = this.createEmptyPlayerState();
  }
}

// ============================================================================
// CLASE Q2CLIENT
// ============================================================================

/**
 * Cliente de Quake 2 que emite eventos
 *
 * Eventos emitidos:
 * - 'console_message' - Mensajes de consola del servidor
 * - 'player_update' - Actualización de posición/estado de jugador
 * - 'entity_update' - Actualización de entidades (items, proyectiles, etc)
 * - 'server_info' - Información del servidor (mapa, mod, etc)
 * - 'connection' - Cambios de estado de conexión
 * - 'raw_message' - Mensaje raw para debug (si debug=true)
 */
export class Q2Client extends EventEmitter {
  constructor(options = {}) {
    super();

    // Configuración
    this.serverIp = options.serverIp || "127.0.0.1";
    this.serverPort = options.serverPort || 27910;
    this.passiveMode = options.passiveMode || false;
    this.monitorMode = options.monitorMode || false;
    this.monitorInterval = options.monitorInterval || 5000;
    this.debug = options.debug || false;
    this.playerName = options.playerName || "Q2Client";

    // Socket UDP
    this.socket = null;

    // Estado de conexión
    this.isConnected = false;
    this.connectionState = "disconnected";
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;

    // Estado del protocolo
    this.clientChallengeId = Math.floor(Math.random() * 0x7fffffff);
    this.clientQport = Math.floor(Math.random() * 255);
    this.serverProtocol = PROTOCOL.VERSION_DEFAULT;
    this.serverProtocolMinor = 0;
    this.netchanType = 1;

    // Estado netchan
    this.incomingSequence = 0;
    this.incomingAcknowledged = 0;
    this.incomingReliableAcknowledged = 0;
    this.incomingReliableSequence = 0;
    this.outgoingSequence = 1;
    this.reliableSequence = 0;
    this.lastReliableSequence = 0;

    // Fragmentación
    this.fragmentSequence = 0;
    this.fragmentBuffer = Buffer.alloc(0);

    // Estado del juego
    this.serverCount = 0;
    this.spawnCount = 0;
    this.lastFrameNum = -1;
    this.currentMapName = "";
    this.configStrings = {};
    this.playerNames = {};

    // Flags de handshake
    this.hasSentNew = false;
    this.hasSentBegin = false;
    this.precacheReceived = false;
    this.hasServerData = false;
    this.respondedVersion = false;
    this.respondedAcToken = false;
    this.sentConfigstrings = false;
    this.sentBaselines = false;
    this.pendingCommands = [];
    this.awaitingBegin = false;

    // Intervalos
    this.heartbeatInterval = null;
    this.keepAliveInterval = null;
    this.monitorPollInterval = null;
    this.lastPacketTime = Date.now();

    // Entity tracker
    this.entityTracker = new EntityTracker();

    // Estado del modo monitor
    this.lastServerStatus = null;
  }

  // ==========================================================================
  // MÉTODOS PÚBLICOS
  // ==========================================================================

  /**
   * Conecta al servidor
   */
  connect() {
    if (this.socket) {
      this.disconnect();
    }

    this.socket = dgram.createSocket("udp4");

    this.socket.on("error", (err) => {
      this.emitEvent("connection", {
        status: "error",
        reason: err.message,
      });
      this.cleanup();
    });

    this.socket.bind(() => {
      if (this.monitorMode) {
        this.socket.on("message", (buffer) => this.handleMonitorPacket(buffer));
        this.startMonitorMode();
      } else {
        this.socket.on("message", (buffer) => this.handleServerPacket(buffer));
        this.requestChallenge();
      }
    });
  }

  /**
   * Desconecta del servidor
   */
  disconnect() {
    this.cleanup();
    this.emitEvent("connection", { status: "disconnected", reason: "user" });
  }

  /**
   * Obtiene el estado actual de un jugador
   */
  getPlayerState() {
    return { ...this.entityTracker.playerState };
  }

  /**
   * Obtiene el estado de una entidad
   */
  getEntity(entityNum) {
    return this.entityTracker.getEntity(entityNum);
  }

  /**
   * Obtiene todas las entidades activas
   */
  getActiveEntities() {
    return this.entityTracker.entities.filter((e) => e.active);
  }

  /**
   * Obtiene información de todos los jugadores conocidos
   */
  getPlayers() {
    const players = [];
    for (const [num, name] of Object.entries(this.playerNames)) {
      players.push({
        id: parseInt(num),
        name: name,
        entity: this.entityTracker.getEntity(parseInt(num) + 1), // player entities start at 1
      });
    }
    return players;
  }

  // ==========================================================================
  // EMISIÓN DE EVENTOS
  // ==========================================================================

  emitEvent(type, data) {
    const event = {
      type,
      timestamp: Date.now(),
      data,
    };
    this.emit(type, event);

    if (this.debug) {
      this.emit("raw_message", event);
    }
  }

  // ==========================================================================
  // UTILIDADES DE PROTOCOLO
  // ==========================================================================

  createOOBPacket(command) {
    return Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from(command + "\n", "ascii"),
    ]);
  }

  createConnectPacket(challenge, protocol) {
    protocol = protocol || this.serverProtocol || PROTOCOL.VERSION_DEFAULT;
    const challengeId = challenge || this.clientChallengeId;

    const userinfo = [
      `\\name\\${this.playerName}`,
      "\\skin\\male/grunt",
      "\\rate\\25000",
      "\\msg\\1",
      "\\hand\\2",
      "\\fov\\90",
      "\\spectator\\1",
    ].join("");

    let connectCommand;

    if (protocol === PROTOCOL.VERSION_Q2PRO) {
      const maxmsglen = 1390;
      const useZlib = 1;
      connectCommand = `connect ${protocol} ${this.clientQport} ${challengeId} "${userinfo}" ${maxmsglen} ${this.netchanType} ${useZlib} ${PROTOCOL_MINOR.Q2PRO_CURRENT}`;
    } else if (protocol === PROTOCOL.VERSION_AQTION) {
      const maxmsglen = 1390;
      const useZlib = 1;
      connectCommand = `connect ${protocol} ${this.clientQport} ${challengeId} "${userinfo}" ${maxmsglen} ${this.netchanType} ${useZlib} ${PROTOCOL_MINOR.AQTION_CURRENT}`;
    } else if (protocol === PROTOCOL.VERSION_R1Q2) {
      const maxmsglen = 1390;
      connectCommand = `connect ${protocol} ${this.clientQport} ${challengeId} "${userinfo}" ${maxmsglen} ${PROTOCOL_MINOR.R1Q2_CURRENT}`;
    } else {
      connectCommand = `connect ${protocol} ${this.clientQport} ${challengeId} "${userinfo}"`;
    }

    return this.createOOBPacket(connectCommand);
  }

  createSequencedPacket(data = null, reliable = false) {
    let sendReliable = reliable;

    let w1 = this.outgoingSequence;
    if (sendReliable) {
      this.reliableSequence ^= 1;
      this.lastReliableSequence = this.outgoingSequence;
      w1 |= 0x80000000;
    }

    let w2 = this.incomingSequence;
    if (this.incomingReliableSequence) {
      w2 |= 0x80000000;
    }

    const parts = [];

    const seqBuffer = Buffer.alloc(4);
    seqBuffer.writeUInt32LE(w1 >>> 0, 0);
    parts.push(seqBuffer);

    const ackBuffer = Buffer.alloc(4);
    ackBuffer.writeUInt32LE(w2 >>> 0, 0);
    parts.push(ackBuffer);

    if (this.serverProtocol >= PROTOCOL.VERSION_R1Q2) {
      const qportBuffer = Buffer.alloc(1);
      qportBuffer.writeUInt8(this.clientQport & 0xff, 0);
      parts.push(qportBuffer);
    } else {
      const qportBuffer = Buffer.alloc(2);
      qportBuffer.writeUInt16LE(this.clientQport & 0xffff, 0);
      parts.push(qportBuffer);
    }

    if (data && data.length > 0) {
      parts.push(data);
    }

    this.outgoingSequence++;

    return Buffer.concat(parts);
  }

  sendSequencedResponse(data = null, reliable = false) {
    if (!this.isConnected || !this.socket) return;

    const packet = this.createSequencedPacket(data, reliable);
    this.socket.send(packet, this.serverPort, this.serverIp);
  }

  sendStringCmd(cmd, reliable = true) {
    if (!this.isConnected) return;

    const cleanCmd = cmd.replace(/[\r\n]/g, "").trim();
    const stringBytes = Buffer.from(cleanCmd, "ascii");
    const cmdBuffer = Buffer.alloc(1 + stringBytes.length + 1);
    cmdBuffer[0] = CLC.STRINGCMD;
    stringBytes.copy(cmdBuffer, 1);
    cmdBuffer[1 + stringBytes.length] = 0;

    const packet = this.createSequencedPacket(cmdBuffer, reliable);
    this.socket.send(packet, this.serverPort, this.serverIp);
  }

  // ==========================================================================
  // LECTURAS DE BUFFER
  // ==========================================================================

  readCString(buffer, startIndex) {
    let end = startIndex;
    while (end < buffer.length && buffer[end] !== 0) {
      end++;
    }
    return {
      text: buffer.slice(startIndex, end).toString("latin1"),
      nextIndex: end + 1,
    };
  }

  readInt16(buffer, idx) {
    if (idx + 2 > buffer.length) return { value: 0, nextIndex: buffer.length };
    return { value: buffer.readInt16LE(idx), nextIndex: idx + 2 };
  }

  readUInt16(buffer, idx) {
    if (idx + 2 > buffer.length) return { value: 0, nextIndex: buffer.length };
    return { value: buffer.readUInt16LE(idx), nextIndex: idx + 2 };
  }

  readInt32(buffer, idx) {
    if (idx + 4 > buffer.length) return { value: 0, nextIndex: buffer.length };
    return { value: buffer.readInt32LE(idx), nextIndex: idx + 4 };
  }

  readCoord(buffer, idx) {
    // Coordinates are stored as short * 8
    if (idx + 2 > buffer.length) return { value: 0, nextIndex: buffer.length };
    const raw = buffer.readInt16LE(idx);
    return { value: raw * 0.125, nextIndex: idx + 2 };
  }

  readAngle(buffer, idx) {
    // Angles are stored as byte * (360/256)
    if (idx >= buffer.length) return { value: 0, nextIndex: buffer.length };
    const raw = buffer[idx];
    return { value: (raw * 360) / 256, nextIndex: idx + 1 };
  }

  readAngle16(buffer, idx) {
    // 16-bit angles
    if (idx + 2 > buffer.length) return { value: 0, nextIndex: buffer.length };
    const raw = buffer.readInt16LE(idx);
    return { value: (raw * 360) / 65536, nextIndex: idx + 2 };
  }

  cleanQuakeString(str) {
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

  // ==========================================================================
  // PARSING DE ENTIDADES
  // ==========================================================================

  /**
   * Parsea bits de entidad y retorna el estado delta
   */
  parseEntityBits(data, idx) {
    if (idx >= data.length) return { bits: 0, nextIndex: idx };

    let bits = data[idx++];

    if (bits & U_MOREBITS1) {
      if (idx >= data.length) return { bits, nextIndex: idx };
      bits |= data[idx++] << 8;
    }

    if (bits & U_MOREBITS2) {
      if (idx >= data.length) return { bits, nextIndex: idx };
      bits |= data[idx++] << 16;
    }

    if (bits & U_MOREBITS3) {
      if (idx >= data.length) return { bits, nextIndex: idx };
      bits |= data[idx++] << 24;
    }

    return { bits, nextIndex: idx };
  }

  /**
   * Parsea el estado de una entidad basado en los bits de delta
   */
  parseEntityState(data, idx, bits, baseline) {
    const state = { ...baseline };

    // Entity number
    let entityNum;
    if (bits & U_NUMBER16) {
      const num = this.readUInt16(data, idx);
      entityNum = num.value;
      idx = num.nextIndex;
    } else {
      entityNum = data[idx++] || 0;
    }
    state.number = entityNum;

    // Check for removal
    if (bits & U_REMOVE) {
      state.removed = true;
      return { state, nextIndex: idx };
    }

    // Model index
    if (bits & U_MODEL) {
      state.modelindex = data[idx++] || 0;
    }

    if (bits & U_MODEL2) {
      state.modelindex2 = data[idx++] || 0;
    }

    if (bits & U_MODEL3) {
      state.modelindex3 = data[idx++] || 0;
    }

    if (bits & U_MODEL4) {
      state.modelindex4 = data[idx++] || 0;
    }

    // Frame
    if (bits & U_FRAME8) {
      state.frame = data[idx++] || 0;
    }
    if (bits & U_FRAME16) {
      const frame = this.readUInt16(data, idx);
      state.frame = frame.value;
      idx = frame.nextIndex;
    }

    // Skin
    if (bits & U_SKIN8 && bits & U_SKIN16) {
      const skin = this.readInt32(data, idx);
      state.skinnum = skin.value;
      idx = skin.nextIndex;
    } else if (bits & U_SKIN8) {
      state.skinnum = data[idx++] || 0;
    } else if (bits & U_SKIN16) {
      const skin = this.readUInt16(data, idx);
      state.skinnum = skin.value;
      idx = skin.nextIndex;
    }

    // Effects
    if (bits & U_EFFECTS8 && bits & U_EFFECTS16) {
      const effects = this.readInt32(data, idx);
      state.effects = effects.value;
      idx = effects.nextIndex;
    } else if (bits & U_EFFECTS8) {
      state.effects = data[idx++] || 0;
    } else if (bits & U_EFFECTS16) {
      const effects = this.readUInt16(data, idx);
      state.effects = effects.value;
      idx = effects.nextIndex;
    }

    // Renderfx
    if (bits & U_RENDERFX8 && bits & U_RENDERFX16) {
      const renderfx = this.readInt32(data, idx);
      state.renderfx = renderfx.value;
      idx = renderfx.nextIndex;
    } else if (bits & U_RENDERFX8) {
      state.renderfx = data[idx++] || 0;
    } else if (bits & U_RENDERFX16) {
      const renderfx = this.readUInt16(data, idx);
      state.renderfx = renderfx.value;
      idx = renderfx.nextIndex;
    }

    // Origin
    if (bits & U_ORIGIN1) {
      const coord = this.readCoord(data, idx);
      state.origin.x = coord.value;
      idx = coord.nextIndex;
    }
    if (bits & U_ORIGIN2) {
      const coord = this.readCoord(data, idx);
      state.origin.y = coord.value;
      idx = coord.nextIndex;
    }
    if (bits & U_ORIGIN3) {
      const coord = this.readCoord(data, idx);
      state.origin.z = coord.value;
      idx = coord.nextIndex;
    }

    // Angles
    if (bits & U_ANGLE1) {
      const angle = this.readAngle(data, idx);
      state.angles.pitch = angle.value;
      idx = angle.nextIndex;
    }
    if (bits & U_ANGLE2) {
      const angle = this.readAngle(data, idx);
      state.angles.yaw = angle.value;
      idx = angle.nextIndex;
    }
    if (bits & U_ANGLE3) {
      const angle = this.readAngle(data, idx);
      state.angles.roll = angle.value;
      idx = angle.nextIndex;
    }

    // Old origin (for lerping)
    if (bits & U_OLDORIGIN) {
      const x = this.readCoord(data, idx);
      idx = x.nextIndex;
      const y = this.readCoord(data, idx);
      idx = y.nextIndex;
      const z = this.readCoord(data, idx);
      idx = z.nextIndex;
      state.old_origin = { x: x.value, y: y.value, z: z.value };
    }

    // Sound
    if (bits & U_SOUND) {
      state.sound = data[idx++] || 0;
    }

    // Event
    if (bits & U_EVENT) {
      state.event = data[idx++] || 0;
    }

    // Solid
    if (bits & U_SOLID) {
      const solid = this.readUInt16(data, idx);
      state.solid = solid.value;
      idx = solid.nextIndex;
    }

    state.active = true;
    return { state, nextIndex: idx };
  }

  /**
   * Parsea svc_playerinfo - estado del jugador local
   */
  parsePlayerState(data, idx, flags) {
    const ps = { ...this.entityTracker.playerState };

    // PM type
    if (flags & PS_M_TYPE) {
      ps.pmove.pm_type = data[idx++] || 0;
    }

    // Origin
    if (flags & PS_M_ORIGIN) {
      const x = this.readInt16(data, idx);
      idx = x.nextIndex;
      const y = this.readInt16(data, idx);
      idx = y.nextIndex;
      const z = this.readInt16(data, idx);
      idx = z.nextIndex;
      ps.pmove.origin = {
        x: x.value * 0.125,
        y: y.value * 0.125,
        z: z.value * 0.125,
      };
    }

    // Velocity
    if (flags & PS_M_VELOCITY) {
      const x = this.readInt16(data, idx);
      idx = x.nextIndex;
      const y = this.readInt16(data, idx);
      idx = y.nextIndex;
      const z = this.readInt16(data, idx);
      idx = z.nextIndex;
      ps.pmove.velocity = {
        x: x.value * 0.125,
        y: y.value * 0.125,
        z: z.value * 0.125,
      };
    }

    // PM time
    if (flags & PS_M_TIME) {
      ps.pmove.pm_time = data[idx++] || 0;
    }

    // PM flags
    if (flags & PS_M_FLAGS) {
      ps.pmove.pm_flags = data[idx++] || 0;
    }

    // Gravity
    if (flags & PS_M_GRAVITY) {
      const g = this.readInt16(data, idx);
      ps.pmove.gravity = g.value;
      idx = g.nextIndex;
    }

    // Delta angles
    if (flags & PS_M_DELTA_ANGLES) {
      const pitch = this.readInt16(data, idx);
      idx = pitch.nextIndex;
      const yaw = this.readInt16(data, idx);
      idx = yaw.nextIndex;
      const roll = this.readInt16(data, idx);
      idx = roll.nextIndex;
      ps.pmove.delta_angles = {
        pitch: (pitch.value * 360) / 65536,
        yaw: (yaw.value * 360) / 65536,
        roll: (roll.value * 360) / 65536,
      };
    }

    // View offset
    if (flags & PS_VIEWOFFSET) {
      ps.viewoffset = {
        x: (data[idx++] || 0) * 0.25,
        y: (data[idx++] || 0) * 0.25,
        z: (data[idx++] || 0) * 0.25,
      };
    }

    // View angles
    if (flags & PS_VIEWANGLES) {
      const pitch = this.readAngle16(data, idx);
      idx = pitch.nextIndex;
      const yaw = this.readAngle16(data, idx);
      idx = yaw.nextIndex;
      const roll = this.readAngle16(data, idx);
      idx = roll.nextIndex;
      ps.viewangles = {
        pitch: pitch.value,
        yaw: yaw.value,
        roll: roll.value,
      };
    }

    // Kick angles
    if (flags & PS_KICKANGLES) {
      ps.kick_angles = {
        pitch: (data[idx++] || 0) * 0.25,
        yaw: (data[idx++] || 0) * 0.25,
        roll: (data[idx++] || 0) * 0.25,
      };
    }

    // Weapon index
    if (flags & PS_WEAPONINDEX) {
      ps.gunindex = data[idx++] || 0;
    }

    // Weapon frame
    if (flags & PS_WEAPONFRAME) {
      ps.gunframe = data[idx++] || 0;
    }

    // Blend
    if (flags & PS_BLEND) {
      ps.blend = [
        (data[idx++] || 0) / 255,
        (data[idx++] || 0) / 255,
        (data[idx++] || 0) / 255,
        (data[idx++] || 0) / 255,
      ];
    }

    // FOV
    if (flags & PS_FOV) {
      ps.fov = data[idx++] || 90;
    }

    // RD flags
    if (flags & PS_RDFLAGS) {
      ps.rdflags = data[idx++] || 0;
    }

    // Stats (32 shorts)
    // En vanilla Q2, los stats siempre se envían completos
    // Pero en Q2PRO/AQtion, usan una máscara de bits
    // Por ahora asumimos que no hay cambios en stats en el delta

    return { playerState: ps, nextIndex: idx };
  }

  /**
   * Parsea svc_packetentities - entidades del frame
   */
  parsePacketEntities(data, idx) {
    const updates = [];

    while (idx < data.length) {
      // Leer bits de la entidad
      const bitsResult = this.parseEntityBits(data, idx);
      idx = bitsResult.nextIndex;
      const bits = bitsResult.bits;

      // bits = 0 significa fin de entidades
      if (bits === 0) {
        break;
      }

      // Leer entity number
      let entityNum;
      if (bits & U_NUMBER16) {
        const num = this.readUInt16(data, idx);
        entityNum = num.value;
        idx = num.nextIndex;
      } else {
        entityNum = data[idx++] || 0;
      }

      if (entityNum === 0 || entityNum >= MAX_EDICTS) {
        break;
      }

      // Obtener baseline
      const baseline =
        this.entityTracker.baselines[entityNum] ||
        this.entityTracker.createEmptyEntity();

      // Parsear estado
      // Re-inject entity number into bits for parsing
      const tempData = Buffer.alloc(data.length);
      data.copy(tempData);

      const stateResult = this.parseEntityStateFromBits(
        data,
        idx,
        bits,
        baseline,
        entityNum
      );
      idx = stateResult.nextIndex;

      // Actualizar tracker y emitir evento
      const entity = this.entityTracker.updateEntity(
        entityNum,
        stateResult.state
      );
      if (entity) {
        updates.push(entity);
      }
    }

    return { updates, nextIndex: idx };
  }

  parseEntityStateFromBits(data, idx, bits, baseline, entityNum) {
    const state = { ...baseline };
    state.number = entityNum;

    // Check for removal
    if (bits & U_REMOVE) {
      state.removed = true;
      state.active = false;
      return { state, nextIndex: idx };
    }

    // Model index
    if (bits & U_MODEL) {
      state.modelindex = data[idx++] || 0;
    }

    if (bits & U_MODEL2) {
      state.modelindex2 = data[idx++] || 0;
    }

    if (bits & U_MODEL3) {
      state.modelindex3 = data[idx++] || 0;
    }

    if (bits & U_MODEL4) {
      state.modelindex4 = data[idx++] || 0;
    }

    // Frame
    if (bits & U_FRAME8) {
      state.frame = data[idx++] || 0;
    }
    if (bits & U_FRAME16) {
      const frame = this.readUInt16(data, idx);
      state.frame = frame.value;
      idx = frame.nextIndex;
    }

    // Skin
    if (bits & U_SKIN8 && bits & U_SKIN16) {
      const skin = this.readInt32(data, idx);
      state.skinnum = skin.value;
      idx = skin.nextIndex;
    } else if (bits & U_SKIN8) {
      state.skinnum = data[idx++] || 0;
    } else if (bits & U_SKIN16) {
      const skin = this.readUInt16(data, idx);
      state.skinnum = skin.value;
      idx = skin.nextIndex;
    }

    // Effects
    if (bits & U_EFFECTS8 && bits & U_EFFECTS16) {
      const effects = this.readInt32(data, idx);
      state.effects = effects.value;
      idx = effects.nextIndex;
    } else if (bits & U_EFFECTS8) {
      state.effects = data[idx++] || 0;
    } else if (bits & U_EFFECTS16) {
      const effects = this.readUInt16(data, idx);
      state.effects = effects.value;
      idx = effects.nextIndex;
    }

    // Renderfx
    if (bits & U_RENDERFX8 && bits & U_RENDERFX16) {
      const renderfx = this.readInt32(data, idx);
      state.renderfx = renderfx.value;
      idx = renderfx.nextIndex;
    } else if (bits & U_RENDERFX8) {
      state.renderfx = data[idx++] || 0;
    } else if (bits & U_RENDERFX16) {
      const renderfx = this.readUInt16(data, idx);
      state.renderfx = renderfx.value;
      idx = renderfx.nextIndex;
    }

    // Origin
    if (bits & U_ORIGIN1) {
      const coord = this.readCoord(data, idx);
      state.origin = state.origin || { x: 0, y: 0, z: 0 };
      state.origin.x = coord.value;
      idx = coord.nextIndex;
    }
    if (bits & U_ORIGIN2) {
      const coord = this.readCoord(data, idx);
      state.origin = state.origin || { x: 0, y: 0, z: 0 };
      state.origin.y = coord.value;
      idx = coord.nextIndex;
    }
    if (bits & U_ORIGIN3) {
      const coord = this.readCoord(data, idx);
      state.origin = state.origin || { x: 0, y: 0, z: 0 };
      state.origin.z = coord.value;
      idx = coord.nextIndex;
    }

    // Angles
    if (bits & U_ANGLE1) {
      const angle = this.readAngle(data, idx);
      state.angles = state.angles || { pitch: 0, yaw: 0, roll: 0 };
      state.angles.pitch = angle.value;
      idx = angle.nextIndex;
    }
    if (bits & U_ANGLE2) {
      const angle = this.readAngle(data, idx);
      state.angles = state.angles || { pitch: 0, yaw: 0, roll: 0 };
      state.angles.yaw = angle.value;
      idx = angle.nextIndex;
    }
    if (bits & U_ANGLE3) {
      const angle = this.readAngle(data, idx);
      state.angles = state.angles || { pitch: 0, yaw: 0, roll: 0 };
      state.angles.roll = angle.value;
      idx = angle.nextIndex;
    }

    // Old origin
    if (bits & U_OLDORIGIN) {
      const x = this.readCoord(data, idx);
      idx = x.nextIndex;
      const y = this.readCoord(data, idx);
      idx = y.nextIndex;
      const z = this.readCoord(data, idx);
      idx = z.nextIndex;
      state.old_origin = { x: x.value, y: y.value, z: z.value };
    }

    // Sound
    if (bits & U_SOUND) {
      state.sound = data[idx++] || 0;
    }

    // Event
    if (bits & U_EVENT) {
      state.event = data[idx++] || 0;
    }

    // Solid
    if (bits & U_SOLID) {
      const solid = this.readUInt16(data, idx);
      state.solid = solid.value;
      idx = solid.nextIndex;
    }

    state.active = true;
    return { state, nextIndex: idx };
  }

  /**
   * Determina el tipo de entidad basado en su modelo/efectos
   */
  getEntityType(entity) {
    // Players are entities 1-256
    if (entity.number > 0 && entity.number <= MAX_CLIENTS) {
      return "player";
    }

    // Projectiles usually have specific effects or models
    if (entity.effects & 0x01) {
      // EF_ROTATE - items
      return "item";
    }

    if (entity.renderfx & 0x04) {
      // RF_BEAM - beams/lasers
      return "projectile";
    }

    if (entity.modelindex > 0) {
      return "entity";
    }

    return "unknown";
  }

  // ==========================================================================
  // PARSING DE MENSAJES
  // ==========================================================================

  parseOOBPacket(buffer) {
    try {
      const isOOB =
        buffer.length >= 4 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xff &&
        buffer[2] === 0xff &&
        buffer[3] === 0xff;

      if (!isOOB) {
        return this.parseSequencedPacket(buffer);
      }

      const content = buffer.slice(4).toString("latin1");
      const lines = content.split("\n");
      const firstLine = lines[0].trim();

      if (firstLine.startsWith("challenge")) {
        const parts = firstLine.split(/\s+/);
        const challengeId = parseInt(parts[1]);
        let supportedProtocols = [];
        for (let i = 2; i < parts.length; i++) {
          if (parts[i].startsWith("p=")) {
            supportedProtocols = parts[i]
              .substring(2)
              .split(",")
              .map((p) => parseInt(p));
          }
        }
        return { type: "challenge", challengeId, supportedProtocols };
      } else if (firstLine.startsWith("print")) {
        const message = content.substring(6).trim();
        return { type: "print", message: this.cleanQuakeString(message) };
      } else if (firstLine.startsWith("client_connect")) {
        const params = {};
        const parts = firstLine.split(/\s+/);
        for (let i = 1; i < parts.length; i++) {
          const [key, value] = parts[i].split("=");
          if (key && value) params[key] = value;
        }
        return { type: "client_connect", params, message: content };
      } else if (firstLine.startsWith("disconnect")) {
        return { type: "disconnect", reason: content.substring(10).trim() };
      } else if (firstLine === "ack") {
        return { type: "ack" };
      } else if (firstLine.startsWith("statusResponse")) {
        return { type: "statusResponse", content };
      } else if (firstLine.startsWith("info")) {
        return { type: "info", content };
      }

      return { type: "unknown_oob", raw: content };
    } catch (error) {
      return null;
    }
  }

  parseSequencedPacket(buffer) {
    if (buffer.length < 8) {
      return { type: "sequenced", error: "Packet too short" };
    }

    const sequenceRaw = buffer.readUInt32LE(0);
    const ackRaw = buffer.readUInt32LE(4);

    const reliable = (sequenceRaw & REL_BIT) !== 0;
    const fragmented = (sequenceRaw & FRG_BIT) !== 0;
    const reliableAck = (ackRaw & REL_BIT) !== 0;

    const sequence = sequenceRaw & NEW_MASK;
    const ack = ackRaw & NEW_MASK;

    let dataOffset = 8;
    let fragmentOffset = 0;
    let moreFragments = false;

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

  decompressZlib(data) {
    try {
      return zlib.inflateRawSync(data);
    } catch (e) {
      return null;
    }
  }

  processServerData(data) {
    if (data.length < 5) {
      return this.parseGameMessage(data, false);
    }

    const firstByte = data[0];

    if (firstByte >= SVC.NOP && firstByte <= SVC.CVARSYNC) {
      return this.parseGameMessage(data, false);
    }

    if (firstByte === 0 || firstByte & 0x80) {
      try {
        const decompressed = zlib.inflateRawSync(data);
        if (decompressed && decompressed.length > 0) {
          return this.parseGameMessage(decompressed, false);
        }
      } catch (e) {
        // Not zlib
      }

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
              return this.parseGameMessage(decompressed, false);
            }
          } catch (e) {
            // Not zlib with header
          }
        }
      }
    }

    return this.parseGameMessage(data, false);
  }

  parseGameMessage(data, isNested = false) {
    const messages = [];
    let idx = 0;

    while (idx < data.length) {
      const opcode = data[idx];
      idx++;

      if (idx > data.length) break;

      let cmd = opcode & SVCMD_MASK;

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
          if (idx >= data.length) return messages;
          const teType = data[idx++];
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
              idx += 6;
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
              idx += 12;
              break;
            default:
              idx += 6;
              break;
          }
          break;
        }

        case SVC.LAYOUT: {
          const { text, nextIndex } = this.readCString(data, idx);
          idx = nextIndex;
          break;
        }

        case SVC.INVENTORY:
          idx += 256 * 2;
          break;

        case SVC.SERVERDATA: {
          if (idx + 9 > data.length) return messages;

          const proto = data.readInt32LE(idx);
          idx += 4;
          this.serverProtocol = proto;

          const srvCount = data.readInt32LE(idx);
          idx += 4;

          const attractloop = data[idx++];

          const gameDir = this.readCString(data, idx);
          idx = gameDir.nextIndex;

          const clientNum = this.readInt16(data, idx);
          idx = clientNum.nextIndex;

          const mapName = this.readCString(data, idx);
          idx = mapName.nextIndex;

          // Protocol-specific data
          if (proto === PROTOCOL.VERSION_R1Q2) {
            if (idx + 5 <= data.length) {
              idx++; // enhanced
              const minorVersion = data.readUInt16LE(idx);
              idx += 2;
              this.serverProtocolMinor = minorVersion;
              idx += 2; // advancedDeltas + strafejumpHack
            }
          } else if (proto === PROTOCOL.VERSION_Q2PRO) {
            if (idx + 3 <= data.length) {
              const minorVersion = data.readUInt16LE(idx);
              idx += 2;
              this.serverProtocolMinor = minorVersion;
              idx++; // serverState
              if (this.serverProtocolMinor >= 1024) {
                if (idx + 2 <= data.length) idx += 2; // flags
              } else {
                if (idx + 3 <= data.length) idx += 3;
              }
            }
          } else if (proto === PROTOCOL.VERSION_AQTION) {
            if (idx + 6 <= data.length) {
              const minorVersion = data.readUInt16LE(idx);
              idx += 2;
              this.serverProtocolMinor = minorVersion;
              idx += 4; // serverState + strafejump + qw + waterjump
            }
          }

          messages.push({
            type: "serverdata",
            protocol: proto,
            serverCount: srvCount,
            attractloop,
            gameDir: gameDir.text,
            clientNum: clientNum.value,
            mapName: this.cleanQuakeString(mapName.text),
          });
          break;
        }

        case SVC.CONFIGSTRING: {
          if (idx + 2 > data.length) return messages;
          const csIndex = data.readUInt16LE(idx);
          idx += 2;
          const { text, nextIndex } = this.readCString(data, idx);
          idx = nextIndex;
          const cleanText = this.cleanQuakeString(text);
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
          // Parse entity baseline
          const bitsResult = this.parseEntityBits(data, idx);
          idx = bitsResult.nextIndex;

          if (bitsResult.bits === 0) break;

          let entityNum;
          if (bitsResult.bits & U_NUMBER16) {
            const num = this.readUInt16(data, idx);
            entityNum = num.value;
            idx = num.nextIndex;
          } else {
            entityNum = data[idx++] || 0;
          }

          const baseline = this.entityTracker.createEmptyEntity();
          const stateResult = this.parseEntityStateFromBits(
            data,
            idx,
            bitsResult.bits,
            baseline,
            entityNum
          );
          idx = stateResult.nextIndex;

          this.entityTracker.setBaseline(entityNum, stateResult.state);
          break;
        }

        case SVC.PRINT: {
          if (idx >= data.length) return messages;
          const level = data[idx++];
          const { text, nextIndex } = this.readCString(data, idx);
          idx = nextIndex;
          const cleanText = this.cleanQuakeString(text);
          if (cleanText) {
            messages.push({ type: "print", level, text: cleanText });
          }
          break;
        }

        case SVC.CENTERPRINT: {
          const { text, nextIndex } = this.readCString(data, idx);
          idx = nextIndex;
          const cleanText = this.cleanQuakeString(text);
          if (cleanText) {
            messages.push({ type: "centerprint", text: cleanText });
          }
          break;
        }

        case SVC.STUFFTEXT: {
          const { text, nextIndex } = this.readCString(data, idx);
          idx = nextIndex;
          const stuffCmd = text.trim();
          if (stuffCmd) {
            messages.push({ type: "stufftext", text: stuffCmd });
          }
          break;
        }

        case SVC.SOUND: {
          if (idx >= data.length) return messages;
          const flags = data[idx++];
          if (flags & 0x20) idx += 2;
          else idx++;
          if (flags & 1) idx++;
          if (flags & 2) idx++;
          if (flags & 0x10) idx++;
          if (flags & 8) idx += 2;
          if (flags & 4) idx += 6;
          break;
        }

        case SVC.DISCONNECT:
          messages.push({ type: "server_disconnect" });
          return messages;

        case SVC.RECONNECT:
          messages.push({ type: "reconnect" });
          return messages;

        case SVC.FRAME: {
          if (idx + 4 > data.length) return messages;

          let frameNum;
          let deltaNum = -1;
          let psFlags = 0;

          if (
            this.serverProtocol === PROTOCOL.VERSION_Q2PRO ||
            this.serverProtocol === PROTOCOL.VERSION_AQTION ||
            this.serverProtocol === PROTOCOL.VERSION_R1Q2
          ) {
            const frameData = data.readUInt32LE(idx);
            idx += 4;
            frameNum = frameData & 0x07ffffff;
            deltaNum = (frameData >> 27) & 0x1f;
            this.lastFrameNum = frameNum;

            if (idx < data.length) {
              const suppressFlags = data[idx++];
            }

            // Areabits
            if (idx < data.length) {
              const areabytes = data[idx++];
              idx += areabytes;
            }

            // Player state flags
            if (idx + 2 <= data.length) {
              psFlags = data.readUInt16LE(idx);
              idx += 2;
            }
          } else {
            frameNum = data.readInt32LE(idx);
            idx += 4;
            this.lastFrameNum = frameNum;

            if (idx + 4 <= data.length) {
              deltaNum = data.readInt32LE(idx);
              idx += 4;
            }

            if (idx < data.length) idx++; // suppresscount

            // Areabits
            if (idx < data.length) {
              const areabytes = data[idx++];
              idx += areabytes;
            }

            // Player state flags
            if (idx + 2 <= data.length) {
              psFlags = data.readUInt16LE(idx);
              idx += 2;
            }
          }

          // Parse player state
          if (psFlags !== 0 && idx < data.length) {
            const psResult = this.parsePlayerState(data, idx, psFlags);
            idx = psResult.nextIndex;
            this.entityTracker.updatePlayerState(psResult.playerState);

            // Emit player state update
            const ps = psResult.playerState;
            messages.push({
              type: "player_state",
              data: {
                position: ps.pmove.origin,
                velocity: ps.pmove.velocity,
                viewangles: ps.viewangles,
                weapon: ps.gunindex,
                fov: ps.fov,
              },
            });
          }

          // Parse packet entities
          if (idx < data.length) {
            const entitiesResult = this.parsePacketEntities(data, idx);
            idx = entitiesResult.nextIndex;

            // Emit entity updates
            for (const entity of entitiesResult.updates) {
              messages.push({
                type: "entity_state",
                data: entity,
              });
            }
          }

          break;
        }

        case SVC.PLAYERINFO:
        case SVC.PACKETENTITIES:
        case SVC.DELTAPACKETENTITIES:
          return messages;

        case SVC.DOWNLOAD: {
          if (idx + 2 > data.length) return messages;
          const size = data.readInt16LE(idx);
          idx += 2;
          idx++;
          if (size > 0) idx += size;
          break;
        }

        case SVC.ZPACKET: {
          if (idx + 4 > data.length) return messages;
          const inlen = data.readUInt16LE(idx);
          idx += 2;
          const outlen = data.readUInt16LE(idx);
          idx += 2;

          if (idx + inlen > data.length) return messages;

          const compressed = data.slice(idx, idx + inlen);
          idx += inlen;

          const decompressed = this.decompressZlib(compressed);
          if (decompressed) {
            const innerMsgs = this.parseGameMessage(decompressed, true);
            messages.push(...innerMsgs);
          }
          break;
        }

        case SVC.GAMESTATE: {
          const CS_END = 0x7fff;
          const MAX_CONFIGSTRINGS = 2080;

          while (idx + 2 <= data.length) {
            const csIndex = data.readUInt16LE(idx);
            idx += 2;

            if (csIndex === CS_END || csIndex >= MAX_CONFIGSTRINGS) break;

            const { text, nextIndex } = this.readCString(data, idx);
            idx = nextIndex;
            const cleanText = this.cleanQuakeString(text);

            if (cleanText) {
              messages.push({
                type: "configstring",
                index: csIndex,
                text: cleanText,
              });
            }
          }
          return messages;
        }

        case SVC.SETTING: {
          if (idx + 8 > data.length) return messages;
          idx += 8;
          break;
        }

        case SVC.CONFIGSTRINGSTREAM:
        case SVC.BASELINESTREAM:
          return messages;

        default:
          if (isNested) continue;
          return messages;
      }
    }

    return messages;
  }

  // ==========================================================================
  // MANEJO DE CONEXIÓN
  // ==========================================================================

  requestChallenge() {
    this.connectionState = "challenging";
    this.emitEvent("connection", { status: "connecting" });
    this.socket.send(
      this.createOOBPacket("getchallenge"),
      this.serverPort,
      this.serverIp
    );
  }

  connectToServer(challengeId) {
    if (challengeId) this.clientChallengeId = challengeId;

    this.connectionState = "connecting";
    this.socket.send(
      this.createConnectPacket(this.clientChallengeId),
      this.serverPort,
      this.serverIp
    );
  }

  sendNewCommand() {
    if (this.hasSentNew) return;
    this.hasSentNew = true;
    this.sendStringCmd("new");
  }

  sendBeginCommand() {
    if (this.hasSentBegin) return;
    this.hasSentBegin = true;

    const beginCount = this.spawnCount || this.serverCount;
    this.sendStringCmd(`begin ${beginCount}`);

    this.connectionState = "spawned";
    this.emitEvent("connection", { status: "spawned" });
  }

  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);

    // Movimiento cada 100ms cuando spawneado, cada 300ms durante handshake
    this.heartbeatInterval = setInterval(
      () => {
        if (!this.isConnected) return;

        if (this.connectionState === "spawned") {
          // Send NOP keepalive cuando está spawned
          const nopPacket = Buffer.from([CLC.NOP]);
          this.sendSequencedResponse(nopPacket, false);
        } else {
          // Durante handshake, enviar keepalive vacío
          this.sendSequencedResponse();
        }
      },
      this.connectionState === "spawned" ? 100 : 300
    );

    // NOP backup cada 10 segundos
    this.keepAliveInterval = setInterval(() => {
      if (this.isConnected) {
        this.sendSequencedResponse(Buffer.from([CLC.NOP]), false);
      }
    }, 10000);
  }

  handleStufftext(text) {
    const lines = text.split("\n");

    for (const line of lines) {
      const cmd = line.trim();
      if (!cmd) continue;

      if (cmd.includes("\x7Fc version") || cmd.includes("c version $version")) {
        if (!this.respondedVersion) {
          this.respondedVersion = true;
          this.pendingCommands.push(`\x7Fc version ${this.playerName} 1.0`);
        }
        continue;
      }

      if (cmd.includes("\x7Fc actoken") || cmd.includes("c actoken $actoken")) {
        if (!this.respondedAcToken) {
          this.respondedAcToken = true;
          this.pendingCommands.push("\x7Fc actoken 0");
        }
        continue;
      }

      if (cmd.includes("\x7Fc check") || cmd.includes("c check")) {
        this.pendingCommands.push("\x7Fc check 0");
        continue;
      }

      if (cmd.startsWith("cmd configstrings")) {
        const match = cmd.match(/cmd configstrings\s*(\d*)/);
        const offset = match && match[1] ? match[1] : "0";
        if (!this.sentConfigstrings) {
          this.sentConfigstrings = true;
          this.pendingCommands.push(`configstrings ${offset}`);
        }
        continue;
      }

      if (cmd.startsWith("cmd baselines")) {
        const match = cmd.match(/cmd baselines\s*(\d*)/);
        const offset = match && match[1] ? match[1] : "0";
        if (!this.sentBaselines) {
          this.sentBaselines = true;
          this.pendingCommands.push(`baselines ${offset}`);
        }
        continue;
      }

      if (cmd.startsWith("precache") && !this.precacheReceived) {
        this.precacheReceived = true;
        const match = cmd.match(/precache\s+(\d+)/);
        if (match) {
          this.spawnCount = parseInt(match[1]);
        } else {
          this.spawnCount = this.serverCount;
        }

        if (this.passiveMode) {
          this.connectionState = "spawned";
          this.emitEvent("connection", { status: "spawned", passive: true });
        } else {
          this.awaitingBegin = true;
        }
        continue;
      }

      if (cmd === "skins" && !this.precacheReceived) {
        this.precacheReceived = true;
        this.spawnCount = this.serverCount;

        if (this.passiveMode) {
          this.connectionState = "spawned";
          this.emitEvent("connection", { status: "spawned", passive: true });
        } else {
          this.awaitingBegin = true;
        }
        continue;
      }

      if (cmd === "reconnect" || cmd.startsWith("reconnect")) {
        this.emitEvent("connection", {
          status: "reconnecting",
          reason: "server_request",
        });
        this.resetConnectionState();
        setTimeout(() => this.requestChallenge(), 500);
        return;
      }

      if (cmd === "disconnect") {
        this.handleDisconnect("server_request");
        return;
      }
    }

    this.processPendingCommands();
  }

  processPendingCommands() {
    if (this.pendingCommands.length === 0 && !this.awaitingBegin) return;

    while (this.pendingCommands.length > 0) {
      const cmd = this.pendingCommands.shift();
      this.sendStringCmd(cmd);
    }

    if (this.awaitingBegin && !this.hasSentBegin) {
      this.awaitingBegin = false;
      setTimeout(() => this.sendBeginCommand(), 500);
    }
  }

  handleServerPacket(buffer) {
    this.lastPacketTime = Date.now();
    const parsed = this.parseOOBPacket(buffer);

    if (!parsed) return;

    switch (parsed.type) {
      case "challenge":
        if (parsed.supportedProtocols && parsed.supportedProtocols.length > 0) {
          if (parsed.supportedProtocols.includes(PROTOCOL.VERSION_AQTION)) {
            this.serverProtocol = PROTOCOL.VERSION_AQTION;
          } else if (
            parsed.supportedProtocols.includes(PROTOCOL.VERSION_Q2PRO)
          ) {
            this.serverProtocol = PROTOCOL.VERSION_Q2PRO;
          } else if (
            parsed.supportedProtocols.includes(PROTOCOL.VERSION_R1Q2)
          ) {
            this.serverProtocol = PROTOCOL.VERSION_R1Q2;
          } else if (
            parsed.supportedProtocols.includes(PROTOCOL.VERSION_DEFAULT)
          ) {
            this.serverProtocol = PROTOCOL.VERSION_DEFAULT;
          }
        }
        setTimeout(() => this.connectToServer(parsed.challengeId), 100);
        break;

      case "client_connect":
        if (parsed.params.nc) {
          this.netchanType = parseInt(parsed.params.nc) || 1;
        }
        this.isConnected = true;
        this.connectionState = "connected";
        this.reconnectAttempts = 0;
        this.emitEvent("connection", { status: "connected" });
        this.startHeartbeat();
        setTimeout(() => this.sendNewCommand(), 200);
        break;

      case "print":
        if (parsed.message.trim()) {
          this.emitEvent("console_message", {
            level: "SERVER",
            text: parsed.message,
          });
        }
        break;

      case "disconnect":
        this.handleDisconnect(parsed.reason);
        break;

      case "statusResponse":
        this.handleStatusResponse(parsed.content);
        break;

      case "sequenced":
        if (parsed.error) {
          // No responder a paquetes con errores de parsing
          return;
        }

        // Verificar si es un paquete duplicado (ignorar bits de reliable/fragment al comparar)
        if (
          parsed.sequence <= this.incomingSequence &&
          this.incomingSequence > 0 &&
          !parsed.fragmented
        ) {
          // Paquete duplicado - ignorar sin responder
          return;
        }

        this.incomingAcknowledged = parsed.ack;
        if (parsed.reliableAck !== (this.incomingReliableAcknowledged === 1)) {
          this.incomingReliableAcknowledged = parsed.reliableAck ? 1 : 0;
        }

        if (parsed.fragmented) {
          if (this.fragmentSequence !== parsed.sequence) {
            this.fragmentSequence = parsed.sequence;
            this.fragmentBuffer = Buffer.alloc(0);
          }

          if (parsed.fragmentOffset !== this.fragmentBuffer.length) {
            // Fragmento fuera de orden - ignorar sin responder
            return;
          }

          if (parsed.data && parsed.data.length > 0) {
            this.fragmentBuffer = Buffer.concat([
              this.fragmentBuffer,
              parsed.data,
            ]);
          }

          if (parsed.moreFragments) {
            // Esperando más fragmentos - no responder hasta tener el paquete completo
            return;
          }

          parsed.data = this.fragmentBuffer;
          parsed.hasData = this.fragmentBuffer.length > 0;
          this.fragmentBuffer = Buffer.alloc(0);
        }

        this.incomingSequence = parsed.sequence;

        if (parsed.reliable) {
          this.incomingReliableSequence ^= 1;
        }

        if (parsed.hasData && parsed.data) {
          const msgs = this.processServerData(parsed.data);

          for (const m of msgs) {
            switch (m.type) {
              case "serverdata":
                if (this.currentMapName && this.currentMapName !== m.mapName) {
                  this.emitEvent("server_info", {
                    event: "map_change",
                    previousMap: this.currentMapName,
                    map: m.mapName,
                  });

                  this.currentMapName = m.mapName;
                  this.serverCount = m.serverCount;
                  this.serverProtocol = m.protocol;

                  this.hasSentNew = false;
                  this.hasSentBegin = false;
                  this.hasServerData = false;
                  this.respondedVersion = false;
                  this.respondedAcToken = false;
                  this.pendingCommands = [];
                  this.awaitingBegin = false;
                  this.lastFrameNum = -1;
                  this.spawnCount = 0;
                  this.configStrings = {};
                  this.entityTracker.reset();

                  setTimeout(() => this.sendNewCommand(), 500);
                  // Responder antes de return para mantener la conexión
                  this.sendSequencedResponse();
                  return;
                }

                this.emitEvent("server_info", {
                  event: "connected",
                  map: m.mapName,
                  gameDir: m.gameDir,
                  protocol: m.protocol,
                });

                this.currentMapName = m.mapName;
                this.hasServerData = true;
                this.serverCount = m.serverCount;
                this.serverProtocol = m.protocol;
                break;

              case "configstring":
                this.configStrings[m.index] = m.text;
                if (m.index >= 1408 && m.index < 1664 && m.text) {
                  const playerNum = m.index - 1408;
                  const name = m.text.split("\\")[0];
                  if (name && name !== this.playerNames[playerNum]) {
                    this.playerNames[playerNum] = name;
                    this.emitEvent("server_info", {
                      event: "player_info",
                      playerId: playerNum,
                      name: name,
                    });
                  }
                } else if (m.index === 0 && m.text) {
                  this.emitEvent("server_info", {
                    event: "map_name",
                    map: m.text,
                  });
                }
                break;

              case "print":
                if (m.text) {
                  const levelName = PRINT_LEVELS[m.level] || "MSG";
                  this.emitEvent("console_message", {
                    level: levelName,
                    text: m.text,
                  });
                }
                break;

              case "centerprint":
                if (m.text) {
                  this.emitEvent("console_message", {
                    level: "CENTER",
                    text: m.text,
                  });
                }
                break;

              case "stufftext":
                this.handleStufftext(m.text);
                break;

              case "server_disconnect":
                this.handleDisconnect("server_disconnect");
                return;

              case "reconnect":
                this.emitEvent("connection", { status: "reconnecting" });
                this.resetConnectionState();
                setTimeout(() => this.requestChallenge(), 1000);
                return;

              /* case "player_state":
                this.emitEvent("player_update", {
                  id: -1, // Local player
                  name: this.playerName,
                  position: m.data.position,
                  angles: m.data.viewangles,
                  velocity: m.data.velocity,
                  weapon: m.data.weapon,
                  fov: m.data.fov,
                  isLocalPlayer: true,
                });
                break;

              case "entity_state":
                const entityType = this.getEntityType(m.data);
                if (entityType === "player" && m.data.number <= MAX_CLIENTS) {
                  const playerId = m.data.number - 1;
                  const playerName =
                    this.playerNames[playerId] || `Player${playerId}`;
                  this.emitEvent("player_update", {
                    id: playerId,
                    name: playerName,
                    position: m.data.origin,
                    angles: m.data.angles,
                    velocity: { x: 0, y: 0, z: 0 },
                    modelIndex: m.data.modelindex,
                    frame: m.data.frame,
                    effects: m.data.effects,
                    alive: m.data.active && !m.data.removed,
                    isLocalPlayer: false,
                  });
                } else {
                  this.emitEvent("entity_update", {
                    id: m.data.number,
                    entityType: entityType,
                    modelIndex: m.data.modelindex,
                    position: m.data.origin,
                    angles: m.data.angles,
                    effects: m.data.effects,
                    renderfx: m.data.renderfx,
                    frame: m.data.frame,
                    removed: m.data.removed || false,
                  });
                }
                break;
                */
            }
          }
        }

        // Responder al servidor para mantener la conexión
        this.sendSequencedResponse();
        break;
    }
  }

  handleDisconnect(reason = "unknown") {
    this.isConnected = false;
    this.connectionState = "disconnected";

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(5000 * this.reconnectAttempts, 30000);

      this.emitEvent("connection", {
        status: "reconnecting",
        reason: reason,
        attempt: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
        delay: delay,
      });

      this.resetConnectionState();
      setTimeout(() => this.requestChallenge(), delay);
    } else {
      this.emitEvent("connection", {
        status: "disconnected",
        reason: "max_reconnect_attempts",
      });
    }
  }

  resetConnectionState() {
    this.hasSentNew = false;
    this.hasSentBegin = false;
    this.precacheReceived = false;
    this.hasServerData = false;

    this.incomingSequence = 0;
    this.incomingAcknowledged = 0;
    this.incomingReliableAcknowledged = 0;
    this.incomingReliableSequence = 0;
    this.outgoingSequence = 1;
    this.reliableSequence = 0;
    this.lastReliableSequence = 0;

    this.lastFrameNum = -1;
    this.configStrings = {};
    this.playerNames = {};
    this.respondedVersion = false;
    this.respondedAcToken = false;
    this.sentConfigstrings = false;
    this.sentBaselines = false;
    this.currentMapName = "";

    this.pendingCommands = [];
    this.awaitingBegin = false;

    this.entityTracker.reset();
  }

  // ==========================================================================
  // MODO MONITOR
  // ==========================================================================

  parseStatusResponse(content) {
    const lines = content.split("\n");
    const result = { info: {}, players: [] };

    if (lines.length >= 2) {
      const infoLine = lines[1];
      const parts = infoLine.split("\\").filter((p) => p);
      for (let i = 0; i < parts.length - 1; i += 2) {
        result.info[parts[i]] = parts[i + 1];
      }
    }

    for (let i = 2; i < lines.length; i++) {
      const playerLine = lines[i].trim();
      if (!playerLine) continue;
      const match = playerLine.match(/^(-?\d+)\s+(\d+)\s+"(.+)"$/);
      if (match) {
        result.players.push({
          score: parseInt(match[1]),
          ping: parseInt(match[2]),
          name: this.cleanQuakeString(match[3]),
        });
      }
    }

    return result;
  }

  sendStatusQuery() {
    this.socket.send(
      this.createOOBPacket("status"),
      this.serverPort,
      this.serverIp
    );
  }

  handleStatusResponse(content) {
    const status = this.parseStatusResponse(content);

    if (this.lastServerStatus) {
      const oldPlayers = new Set(
        this.lastServerStatus.players.map((p) => p.name)
      );
      const newPlayers = new Set(status.players.map((p) => p.name));

      for (const player of status.players) {
        if (!oldPlayers.has(player.name)) {
          this.emitEvent("server_info", {
            event: "player_join",
            name: player.name,
            ping: player.ping,
          });
        }
      }

      for (const player of this.lastServerStatus.players) {
        if (!newPlayers.has(player.name)) {
          this.emitEvent("server_info", {
            event: "player_leave",
            name: player.name,
          });
        }
      }

      if (
        status.info.mapname &&
        this.lastServerStatus.info.mapname !== status.info.mapname
      ) {
        this.emitEvent("server_info", {
          event: "map_change",
          previousMap: this.lastServerStatus.info.mapname,
          map: status.info.mapname,
        });
      }
    } else {
      this.emitEvent("server_info", {
        event: "status",
        hostname: this.cleanQuakeString(
          status.info.hostname || "Quake 2 Server"
        ),
        map: status.info.mapname || "unknown",
        players: status.players.length,
        maxPlayers: parseInt(status.info.maxclients) || 0,
        gameDir: status.info.game || "baseq2",
        playerList: status.players,
      });
    }

    this.lastServerStatus = status;
  }

  handleMonitorPacket(buffer) {
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

    if (
      firstLine === "statusResponse" ||
      firstLine.startsWith("statusResponse")
    ) {
      this.handleStatusResponse(content);
    } else if (
      firstLine.startsWith("print") &&
      lines.length >= 2 &&
      lines[1].startsWith("\\")
    ) {
      const fakeStatus = "statusResponse\n" + lines.slice(1).join("\n");
      this.handleStatusResponse(fakeStatus);
    } else if (firstLine.startsWith("print")) {
      const message = this.cleanQuakeString(content.substring(6));
      if (message.trim()) {
        this.emitEvent("console_message", {
          level: "SERVER",
          text: message,
        });
      }
    }
  }

  startMonitorMode() {
    this.emitEvent("connection", { status: "monitoring" });

    this.sendStatusQuery();

    this.monitorPollInterval = setInterval(() => {
      this.sendStatusQuery();
    }, this.monitorInterval);
  }

  // ==========================================================================
  // LIMPIEZA
  // ==========================================================================

  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    if (this.monitorPollInterval) {
      clearInterval(this.monitorPollInterval);
      this.monitorPollInterval = null;
    }

    if (this.isConnected && this.socket) {
      this.socket.send(
        this.createOOBPacket("disconnect"),
        this.serverPort,
        this.serverIp
      );
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.isConnected = false;
    this.connectionState = "disconnected";
  }
}

// Export default
export default Q2Client;

// Named exports for convenience
export { PROTOCOL, SVC, CLC, PRINT_LEVELS, EntityTracker };
