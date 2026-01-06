import dgram from "dgram";

export const getServerStatus = (host, port) => {
  return new Promise((resolve, reject) => {
    const payload = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from("status\n", "ascii"),
    ]);

    const socket = dgram.createSocket("udp4");
    const timeout = setTimeout(() => {
      socket.close();
      reject(
        new Error(
          `Timeout: No se recibió respuesta del servidor: ${host}:${port}`
        )
      );
    }, 1000);

    socket.send(payload, port, host, (err) => {
      if (err) {
        reject(new Error(`❌ Error al enviar status: ${err.message}`));
        clearTimeout(timeout);
        socket.close();
      }
    });

    socket.on("message", (msg, rinfo) => {
      try {
        const content = msg.subarray(4).toString();
        const lines = content.split("\n");

        // Omitir la primera línea "print"
        const dataLines = lines.slice(1);

        // Primera línea después del print contiene la configuración
        const configLine = dataLines[0] || "";
        const config = {};
        if (configLine.startsWith("\\")) {
          const configPairs = configLine.slice(1).split("\\");
          for (let i = 0; i < configPairs.length; i += 2) {
            if (configPairs[i] && configPairs[i + 1] !== undefined) {
              config[configPairs[i]] = configPairs[i + 1];
            }
          }
        }

        // Las líneas restantes son jugadores
        const players = [];
        for (let i = 1; i < dataLines.length; i++) {
          const line = dataLines[i].trim();
          if (line) {
            const parts = line.split(" ");
            if (parts.length >= 3) {
              const frags = parseInt(parts[0], 10);
              const ping = parseInt(parts[1], 10);
              // El nombre puede contener espacios, así que tomamos desde el tercer elemento en adelante
              const name = parts.slice(2).join(" ").replace(/^"|"$/g, "");
              players.push({ frags, ping, name });
            }
          }
        }

        const result = {
          config,
          players,
          net: { host, port },
        };
        resolve(result);
      } catch (error) {
        reject(new Error(`❌ Error al parsear respuesta: ${error.message}`));
      } finally {
        clearTimeout(timeout);
        socket.close();
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`❌ Error en el socket: ${err.message}`));
      clearTimeout(timeout);
      socket.close();
    });
  });
};
