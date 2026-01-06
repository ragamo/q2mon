import { Box, Text } from "ink";
import { Q2Client } from "../../libs/q2client";
import { useState, useEffect } from "react";

function getShortTimestamp() {
  return new Date().toISOString().split("T")[1].slice(0, 12);
}

export const ServerLog = ({ host, port }) => {
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState([]);

  useEffect(() => {
    console.log(host, port);

    const q2Client = new Q2Client({
      serverIp: host,
      serverPort: port,
      playerName: "Spectre",
      debug: false,
    });

    q2Client.on("console_message", (event) => {
      const { level, text } = event.data;
      setLog((prev) => [...prev, `${getShortTimestamp()} [${level}] ${text}`]);
    });

    /* q2Client.on("raw_message", (event) => {
      console.log(
        `🔧 RAW [${event.type}]:`,
        JSON.stringify(event.data).substring(0, 100)
      );
    }); */

    q2Client.connect();
    setLoading(false);
    return () => {
      q2Client.disconnect();
      setLoading(true);
      setLog([]);
    };
  }, [host, port]);

  return (
    <Box>
      {loading ? <Text>Loading...</Text> : <Text>{log.join("\n")}</Text>}
    </Box>
  );
};
